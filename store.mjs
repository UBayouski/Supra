import { initialState } from './model.mjs';

export function memoryStore(initial = initialState()) {
  let state = structuredClone(initial);
  return {
    get: () => structuredClone(state),
    async change(operation) {
      const draft = structuredClone(state);
      const result = operation(draft);
      state = draft;
      return result;
    },
  };
}
