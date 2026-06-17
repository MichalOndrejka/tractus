import {
  type BacklogState,
  type BacklogItemType,
  BACKLOG_STATES,
} from '@tractus/shared';

const STATE_LABEL_PREFIX = 'state:';
const TYPE_LABEL_PREFIX = 'type:';
const PRIORITY_LABEL_PREFIX = 'priority:';

const PRIORITY_MAP: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const VALID_STATES = new Set<string>(BACKLOG_STATES);
const VALID_TYPES = new Set<BacklogItemType>(['feature', 'bug', 'chore', 'design']);

/** Derive the backlog state from an issue's labels (defaults to BACKLOG). */
export function stateFromLabels(labels: string[]): BacklogState {
  for (const label of labels) {
    if (label.startsWith(STATE_LABEL_PREFIX)) {
      const candidate = label.slice(STATE_LABEL_PREFIX.length).toUpperCase();
      if (VALID_STATES.has(candidate)) return candidate as BacklogState;
    }
  }
  return 'BACKLOG';
}

export function typeFromLabels(labels: string[]): BacklogItemType {
  for (const label of labels) {
    if (label.startsWith(TYPE_LABEL_PREFIX)) {
      const candidate = label.slice(TYPE_LABEL_PREFIX.length).toLowerCase();
      if (VALID_TYPES.has(candidate as BacklogItemType)) return candidate as BacklogItemType;
    }
    // also accept bare GitHub labels like "bug"
    if (label.toLowerCase() === 'bug') return 'bug';
  }
  return 'feature';
}

export function priorityFromLabels(labels: string[]): number {
  for (const label of labels) {
    if (label.startsWith(PRIORITY_LABEL_PREFIX)) {
      const key = label.slice(PRIORITY_LABEL_PREFIX.length).toLowerCase();
      if (key in PRIORITY_MAP) return PRIORITY_MAP[key];
    }
  }
  return 0;
}

export const stateLabel = (state: BacklogState) => `${STATE_LABEL_PREFIX}${state}`;
