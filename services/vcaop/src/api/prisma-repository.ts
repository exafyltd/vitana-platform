/**
 * Prisma-backed Repository + same-transaction OASIS write (CTRL-API-0004 follow-up,
 * runbook Sec. 4 / Sec. 6 AC: "all writes emit OASIS events ... in the same tx as
 * the read-model write").
 *
 * Depends on a minimal `PrismaLike` shape (not a hard import of @prisma/client) so
 * it builds without the generated client and is unit-testable with a fake. The
 * Gateway injects the real `PrismaClient` (it satisfies PrismaLike). `writeWithEvent`
 * runs the model mutation AND the oasis_events insert inside one `$transaction` —
 * both commit or both roll back.
 */
import { Repository, Record_, newId } from './repository';
import { sanitizeEvent, OasisEvent } from './oasis-sink';

/** Minimal Prisma delegate surface we use. */
export interface PrismaDelegate {
  create(args: { data: Record_ }): Promise<Record_>;
  findUnique(args: { where: { id: string } }): Promise<Record_ | null>;
  findMany(args?: Record<string, unknown>): Promise<Record_[]>;
  update(args: { where: { id: string }; data: Partial<Record_> }): Promise<Record_>;
}

/** Minimal Prisma client surface: model delegates + $transaction. */
export interface PrismaLike {
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
  [model: string]: unknown;
}

/** VCAOP collection (snake_case table) → Prisma model accessor (camelCase). */
export const COLLECTION_TO_MODEL: Record<string, string> = {
  business_identity: 'businessIdentity',
  provider: 'provider',
  provider_account: 'providerAccount',
  provisioning_job: 'provisioningJob',
  job_step: 'jobStep',
  job_attempt: 'jobAttempt',
  job_artifact: 'jobArtifact',
  human_task: 'humanTask',
  account_health_snapshot: 'accountHealthSnapshot',
  affiliate_program: 'affiliateProgram',
  commission_event: 'commissionEvent',
  rewards_ledger: 'rewardsLedger',
  user_reward_link: 'userRewardLink',
  cart_order: 'cartOrder',
  merchant_route: 'merchantRoute',
  disclosure: 'disclosure',
  oasis_events: 'oasisEvent',
};

function delegate(client: PrismaLike, collection: string): PrismaDelegate {
  const model = COLLECTION_TO_MODEL[collection];
  if (!model) throw new Error(`no Prisma model mapped for collection "${collection}"`);
  const d = client[model] as PrismaDelegate | undefined;
  if (!d) throw new Error(`Prisma client has no delegate "${model}"`);
  return d;
}

export class PrismaRepository implements Repository {
  constructor(private readonly client: PrismaLike) {}

  async list(collection: string, filter?: (r: Record_) => boolean): Promise<Record_[]> {
    const rows = await delegate(this.client, collection).findMany();
    return filter ? rows.filter(filter) : rows;
  }
  async get(collection: string, id: string): Promise<Record_ | null> {
    return delegate(this.client, collection).findUnique({ where: { id } });
  }
  async create(collection: string, record: Record_): Promise<Record_> {
    const data = { ...record, id: record.id || newId(collection) };
    return delegate(this.client, collection).create({ data });
  }
  async update(collection: string, id: string, patch: Partial<Record_>): Promise<Record_ | null> {
    return delegate(this.client, collection).update({ where: { id }, data: patch });
  }
}

export interface WriteWithEventInput {
  collection: string;
  record: Record_;
  event: Omit<OasisEvent, 'createdAt'>;
}

/**
 * Mutating write + OASIS event in ONE transaction (Sec. 4 AC). The event is
 * sanitized (PII redacted + asserted) BEFORE the transaction so a bad payload never
 * opens a tx. If either insert fails, the whole unit rolls back — no read-model row
 * without its event, and no event without its row.
 */
export async function writeWithEvent(client: PrismaLike, input: WriteWithEventInput): Promise<Record_> {
  const event = sanitizeEvent(input.event); // throws on PII before we touch the DB
  return client.$transaction(async (tx) => {
    const created = await delegate(tx, input.collection).create({
      data: { ...input.record, id: input.record.id || newId(input.collection) },
    });
    await delegate(tx, 'oasis_events').create({
      data: {
        id: newId('oasis'),
        type: event.type,
        topic: event.type,
        source: event.source,
        status: event.status,
        message: event.message,
        metadata: event.payload,
        vtid: (event.payload as { vtid?: string }).vtid ?? null,
        created_at: event.createdAt,
      },
    });
    return created;
  });
}
