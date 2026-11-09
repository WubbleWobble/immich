import { SearchFilter, SearchFilterBranch } from 'src/dtos/search.dto.js';

type IdsFilterField = 'albumIds' | 'personIds' | 'tagIds';

const filterBranches = (filter: SearchFilter): SearchFilterBranch[] => [filter, ...(filter.or ?? [])];

export const collectFilterIds = (filter: SearchFilter, field: IdsFilterField): string[] => {
  const ids = new Set<string>();

  for (const branch of filterBranches(filter)) {
    for (const operator of ['any', 'all', 'none'] as const) {
      for (const id of branch[field]?.[operator] ?? []) {
        ids.add(id);
      }
    }
  }

  return [...ids];
};
