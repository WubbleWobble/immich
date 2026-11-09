import { SearchFilter, SearchFilterBranch } from 'src/dtos/search.dto.js';

type IdsFilterField = 'albumIds' | 'personIds' | 'tagIds';
type IdsFilterOperator = 'any' | 'all' | 'none';

const ALL_OPERATORS: IdsFilterOperator[] = ['any', 'all', 'none'];

/** The v3.3.6 grammar has exactly two places for conditions: the root and each `or` branch (no nesting, no `and`). */
const filterBranches = (filter: SearchFilter): SearchFilterBranch[] => [filter, ...(filter.or ?? [])];

export const collectFilterIds = (
  filter: SearchFilter,
  field: IdsFilterField,
  operators: IdsFilterOperator[] = ALL_OPERATORS,
): string[] => {
  const ids = new Set<string>();

  for (const branch of filterBranches(filter)) {
    for (const operator of operators) {
      for (const id of branch[field]?.[operator] ?? []) {
        ids.add(id);
      }
    }
  }

  return [...ids];
};
