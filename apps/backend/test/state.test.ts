import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priorityFromLabels,
  stateFromLabels,
  stateLabel,
  typeFromLabels,
} from '../src/state.js';

test('stateFromLabels: reads state: label case-insensitively, defaults to BACKLOG', () => {
  assert.equal(stateFromLabels(['state:READY']), 'READY');
  assert.equal(stateFromLabels(['state:in_review']), 'IN_REVIEW');
  assert.equal(stateFromLabels(['state:bogus']), 'BACKLOG'); // unknown candidate ignored
  assert.equal(stateFromLabels(['enhancement']), 'BACKLOG'); // no state label
  assert.equal(stateFromLabels([]), 'BACKLOG');
});

test('typeFromLabels: type: prefix, bare "bug", default feature', () => {
  assert.equal(typeFromLabels(['type:feature']), 'feature');
  assert.equal(typeFromLabels(['type:bug']), 'bug');
  assert.equal(typeFromLabels(['bug']), 'bug'); // bare GitHub label
  assert.equal(typeFromLabels(['type:chore']), 'feature'); // removed type -> default
  assert.equal(typeFromLabels(['type:nonsense']), 'feature'); // invalid -> default
  assert.equal(typeFromLabels([]), 'feature');
});

test('priorityFromLabels: maps named priorities, else 0', () => {
  assert.equal(priorityFromLabels(['priority:urgent']), 4);
  assert.equal(priorityFromLabels(['priority:high']), 3);
  assert.equal(priorityFromLabels(['priority:medium']), 2);
  assert.equal(priorityFromLabels(['priority:low']), 1);
  assert.equal(priorityFromLabels(['priority:whatever']), 0);
  assert.equal(priorityFromLabels(['something']), 0);
});

test('stateLabel builds the GitHub label', () => {
  assert.equal(stateLabel('READY'), 'state:READY');
  assert.equal(stateLabel('DONE'), 'state:DONE');
});
