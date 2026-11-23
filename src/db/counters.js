/**
 * Sequences (Postgres `create sequence … start N`) as documents in the `counters` collection:
 * `{ _id: '<sequence name>', value: <last value handed out> }`.
 *
 * A counter document is created on first use with the sequence's start value, so a fresh database
 * needs no seeding. Like Postgres sequences, counters are deliberately NOT part of transactions:
 * an aborted write leaves a gap but two concurrent writers never conflict on the counter.
 */
import mongoose from 'mongoose';

/** First value each sequence hands out (same as the Postgres migrations). */
export const SEQUENCE_STARTS = Object.freeze({
  lead_code_seq: 1001,
  follow_up_code_seq: 1,
  project_follow_up_code_seq: 1,
  team_task_code_seq: 1,
  project_code_seq: 101,
  task_code_seq: 1,
  bug_code_seq: 1001,
  time_log_code_seq: 1,
  user_code_seq: 1000,
  member_code_seq: 1000,
  role_code_seq: 1000,
  // bigIncrements primary keys use `<table>_id_seq` and start at 1 (not listed).
});

const startOf = (name) => SEQUENCE_STARTS[name] ?? 1;
const counters = () => mongoose.connection.collection('counters');

/**
 * Reserve `count` consecutive values of a sequence atomically and return the first one.
 * @param {string} name sequence name, e.g. 'lead_code_seq' or 'audit_logs_id_seq'
 * @param {number} [count=1]
 */
export async function nextSeqBlock(name, count = 1) {
  const doc = await counters().findOneAndUpdate(
    { _id: name },
    [{ $set: { value: { $add: [{ $ifNull: ['$value', startOf(name) - 1] }, count] } } }],
    { upsert: true, returnDocument: 'after' },
  );
  return doc.value - count + 1;
}

/** Next value of a sequence (Postgres nextval). */
export const nextSeq = (name) => nextSeqBlock(name, 1);

/**
 * Set the last value handed out (Postgres `setval(name, value)`): the next call returns value + 1.
 * Used by test fixtures that insert rows with explicit codes.
 */
export async function setSeq(name, value) {
  await counters().updateOne({ _id: name }, { $set: { value } }, { upsert: true });
}

/** Forget every counter (test reset: sequences start over from SEQUENCE_STARTS). */
export async function resetSequences() {
  await counters().deleteMany({});
}
