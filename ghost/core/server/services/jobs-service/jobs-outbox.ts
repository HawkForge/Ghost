import type { Knex } from 'knex';
import { z } from 'zod';
import type { DispatchEnvelope } from '@tryghost/adapter-base-jobs';
import { DbJson } from '../../lib/db-types/json';

const TABLE = 'jobs_outbox';

export const OutboxEnvelope = DbJson(
  z.object({
    version: z.literal(1),
    payload: z.object({
      job: z.object({ type: z.string(), payload: z.string() }),
      routing: z.object({ queue: z.string().optional() }).optional(),
    }),
  }),
  { message: 'The stored jobs outbox envelope is not JSON.' },
);

export type SubmitFn = (id: string, envelope: DispatchEnvelope) => Promise<void>;

export interface OutboxEntry {
  id: string;
  envelope: DispatchEnvelope;
}

export interface InsertOptions {
  transacting?: Knex.Transaction;
}

export type ProcessOutcome =
  | { status: 'idle' }
  | { status: 'delivered'; id: string }
  | { status: 'failed'; id: string; error: unknown };

interface ClaimedRow {
  id: string;
  envelope: string;
}

export class JobsOutbox {
  readonly #knex: Knex;

  constructor({ knex }: { knex: Knex }) {
    this.#knex = knex;
  }

  async insert({ id, envelope }: OutboxEntry, { transacting }: InsertOptions = {}): Promise<void> {
    const now = new Date();
    const row = {
      id,
      envelope: z.encode(OutboxEnvelope, envelope),
      created_at: now,
      available_at: now,
    };
    const query = this.#knex(TABLE).insert(row);
    await (transacting ? query.transacting(transacting) : query);
  }

  async processNext(
    submit: SubmitFn,
    { retryDelayMs }: { retryDelayMs: number },
  ): Promise<ProcessOutcome> {
    return this.#knex.transaction(async (trx) => {
      const row = await trx<ClaimedRow>(TABLE)
        .select('id', 'envelope')
        .where('available_at', '<=', new Date())
        .orderBy([{ column: 'available_at' }, { column: 'id' }])
        .forUpdate()
        .skipLocked()
        .first();

      if (!row) {
        return { status: 'idle' };
      }

      const { id } = row;

      // Decoding is inside the try so a row that cannot be read takes the same
      // retry path as a rejected submission, instead of throwing out of the
      // transaction and being re-claimed first on every poll.
      try {
        const envelope: DispatchEnvelope = z.decode(OutboxEnvelope, row.envelope);
        await submit(id, envelope);
      } catch (error) {
        await trx(TABLE)
          .where('id', id)
          .update({ available_at: new Date(Date.now() + retryDelayMs) });
        return { status: 'failed', id, error };
      }

      await trx(TABLE).where('id', id).delete();
      return { status: 'delivered', id };
    });
  }
}
