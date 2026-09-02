import { odata, type TableClient, type TransactionAction } from '@azure/data-tables'
import { ulid } from 'ulid'

import {
  BATCH_PARTITION,
  batchRowKey,
  ledgerPartitionKey,
  allocationRowKey,
  transactionRowKey,
  idempotencyRowKey,
  batchProvisionOpId,
} from '../storage/keys.js'
import { isConflict, isNotFound } from '../storage/tableClient.js'
import type { BatchStatus } from '../storage/entities.js'

/**
 * Batch creation is the one operation that cannot be atomic.
 *
 * Granting quotas to six members touches six partitions, and Azure Table
 * Storage offers transactions only within a single partition. Rather than
 * pretend otherwise, this is a two-phase, idempotent, resumable flow:
 *
 *   1. record the batch as `provisioning`
 *   2. one atomic entity-group transaction per member
 *   3. flip the batch to `active`
 *
 * Each per-member step is keyed by a deterministic operation id, so re-running
 * a partially failed batch converges instead of double-granting. The honest
 * consequence: between a failure and its repair, some members can drink from
 * the batch and others cannot. Nothing is lost, and nothing is granted twice.
 */

export class BatchNotFoundError extends Error {
  readonly code = 'BATCH_NOT_FOUND'
  constructor() {
    super('No such batch')
    this.name = 'BatchNotFoundError'
  }
}

export class InvalidBatchError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBatchError'
  }
}

export interface BatchDeps {
  batches: TableClient
  ledger: TableClient
  now?: () => Date
}

export interface AllocationRequest {
  memberId: string
  units: number
}

export interface CreateBatchInput {
  label: string
  purchasedAt?: Date
  effectiveAt?: Date
  allocations: AllocationRequest[]
}

export interface BatchSummary {
  batchId: string
  label: string
  purchasedAt: Date
  effectiveAt: Date
  totalUnits: number
  status: BatchStatus
  createdByMemberId: string
  provisionedMemberIds: string[]
}

function toSummary(row: Record<string, unknown>): BatchSummary {
  return {
    batchId: String(row.batchId),
    label: String(row.label ?? ''),
    purchasedAt: new Date(String(row.purchasedAt)),
    effectiveAt: new Date(String(row.effectiveAt)),
    totalUnits: Number(row.totalUnits ?? 0),
    status: String(row.status ?? 'provisioning') as BatchStatus,
    createdByMemberId: String(row.createdByMemberId ?? ''),
    provisionedMemberIds: JSON.parse(String(row.provisionedMemberIds ?? '[]')) as string[],
  }
}

/** Phase 2 for a single member — atomic within that member's partition. */
async function provisionMember(
  deps: BatchDeps,
  batch: BatchSummary,
  req: AllocationRequest,
  actorMemberId: string,
): Promise<void> {
  const partitionKey = ledgerPartitionKey(req.memberId)
  const opId = batchProvisionOpId(batch.batchId, req.memberId)
  const at = deps.now?.() ?? new Date()
  const allocRowKey = allocationRowKey(batch.effectiveAt, batch.batchId)

  const actions: TransactionAction[] = [
    [
      'create',
      {
        partitionKey,
        rowKey: allocRowKey,
        kind: 'allocation',
        batchId: batch.batchId,
        batchLabel: batch.label,
        granted: req.units,
        consumed: 0,
        remaining: req.units,
        effectiveAt: batch.effectiveAt,
      },
    ],
    [
      'create',
      {
        partitionKey,
        rowKey: transactionRowKey(at, opId),
        kind: 'transaction',
        type: 'GRANT',
        delta: req.units,
        allocRowKey,
        batchId: batch.batchId,
        batchLabel: batch.label,
        opId,
        actorMemberId,
        subjectMemberId: req.memberId,
        createdAt: at,
      },
    ],
    [
      'create',
      {
        partitionKey,
        rowKey: idempotencyRowKey(opId),
        kind: 'idempotency',
        txnRowKey: transactionRowKey(at, opId),
        statusCode: 201,
        resultJson: JSON.stringify({ batchId: batch.batchId, units: req.units }),
        createdAt: at,
      },
    ],
  ]

  try {
    await deps.ledger.submitTransaction(actions)
  } catch (err) {
    // Already provisioned by an earlier run: converge, do not double-grant.
    if (isConflict(err)) return
    throw err
  }
}

export async function createBatch(
  deps: BatchDeps,
  actorMemberId: string,
  input: CreateBatchInput,
): Promise<BatchSummary> {
  if (!input.label?.trim()) throw new InvalidBatchError('A batch label is required')
  if (!input.allocations?.length) throw new InvalidBatchError('A batch needs at least one allocation')
  for (const a of input.allocations) {
    if (!Number.isInteger(a.units) || a.units <= 0) {
      throw new InvalidBatchError(`Units for ${a.memberId} must be a positive whole number`)
    }
  }
  const seen = new Set<string>()
  for (const a of input.allocations) {
    if (seen.has(a.memberId)) throw new InvalidBatchError(`Duplicate allocation for ${a.memberId}`)
    seen.add(a.memberId)
  }

  const at = deps.now?.() ?? new Date()
  const batch: BatchSummary = {
    batchId: ulid(),
    label: input.label.trim(),
    purchasedAt: input.purchasedAt ?? at,
    effectiveAt: input.effectiveAt ?? at,
    totalUnits: input.allocations.reduce((s, a) => s + a.units, 0),
    status: 'provisioning',
    createdByMemberId: actorMemberId,
    provisionedMemberIds: [],
  }

  // Phase 1 — the batch exists before any allocation does, so a crash leaves a
  // visible, repairable record rather than orphaned units.
  await deps.batches.createEntity({
    partitionKey: BATCH_PARTITION,
    rowKey: batchRowKey(batch.effectiveAt, batch.batchId),
    kind: 'batch',
    batchId: batch.batchId,
    label: batch.label,
    purchasedAt: batch.purchasedAt,
    effectiveAt: batch.effectiveAt,
    totalUnits: batch.totalUnits,
    status: 'provisioning',
    createdByMemberId: actorMemberId,
    provisionedMemberIds: '[]',
  })

  return finishProvisioning(deps, batch, input.allocations, actorMemberId)
}

async function finishProvisioning(
  deps: BatchDeps,
  batch: BatchSummary,
  allocations: AllocationRequest[],
  actorMemberId: string,
): Promise<BatchSummary> {
  const provisioned: string[] = []
  for (const req of allocations) {
    await provisionMember(deps, batch, req, actorMemberId)
    provisioned.push(req.memberId)
  }

  await deps.batches.updateEntity(
    {
      partitionKey: BATCH_PARTITION,
      rowKey: batchRowKey(batch.effectiveAt, batch.batchId),
      status: 'active',
      provisionedMemberIds: JSON.stringify(provisioned),
    },
    'Merge',
  )

  return { ...batch, status: 'active', provisionedMemberIds: provisioned }
}

export async function findBatch(deps: BatchDeps, batchId: string): Promise<BatchSummary> {
  const iter = deps.batches.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${BATCH_PARTITION} and batchId eq ${batchId}` },
  })
  for await (const e of iter) return toSummary(e as Record<string, unknown>)
  throw new BatchNotFoundError()
}

/**
 * Re-run phase 2 for a batch left in `provisioning`. Safe to call repeatedly:
 * every per-member step is guarded by its deterministic operation id.
 */
export async function reprovisionBatch(
  deps: BatchDeps,
  actorMemberId: string,
  batchId: string,
  allocations: AllocationRequest[],
): Promise<BatchSummary> {
  const batch = await findBatch(deps, batchId)
  return finishProvisioning(deps, batch, allocations, actorMemberId)
}

export async function listBatches(deps: BatchDeps): Promise<BatchSummary[]> {
  const out: BatchSummary[] = []
  const iter = deps.batches.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${BATCH_PARTITION}` },
  })
  for await (const e of iter) out.push(toSummary(e as Record<string, unknown>))
  return out.sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())
}

export async function batchExists(deps: BatchDeps, batchId: string): Promise<boolean> {
  try {
    await findBatch(deps, batchId)
    return true
  } catch (err) {
    if (err instanceof BatchNotFoundError || isNotFound(err)) return false
    throw err
  }
}
