import { getPerson, getTagById, isHttpError, type SmartAlbumFilter } from '@immich/sdk';

/** Person/tag ids a smart filter references that no longer resolve (D12: they match nothing). */
export type DanglingSmartAlbumReferences = { personIds: string[]; tagIds: string[] };

/** Resolves to true when the id exists, false when it is gone, undefined when that cannot be told. */
export type ReferenceResolver = (id: string) => Promise<boolean | undefined>;

const resolveWith = (load: (id: string) => Promise<unknown>): ReferenceResolver => {
  return async (id) => {
    try {
      await load(id);
      return true;
    } catch (error) {
      // The server answers 400 "Not found or no access" (or 404) for an id that is gone. Anything
      // else (network, 5xx) says nothing about the reference, so it is not flagged.
      if (isHttpError(error) && (error.status === 400 || error.status === 404)) {
        return false;
      }
      return undefined;
    }
  };
};

const defaultResolvers = {
  person: resolveWith((id) => getPerson({ id })),
  tag: resolveWith((id) => getTagById({ id })),
};

/**
 * Find the person/tag ids in `filter` that no longer resolve. Only meaningful for the album
 * owner: the referenced people and tags are the owner's, so other users cannot resolve them.
 */
export async function findDanglingSmartAlbumReferences(
  filter: Pick<SmartAlbumFilter, 'personIds' | 'tagIds'> | null | undefined,
  resolvers: { person: ReferenceResolver; tag: ReferenceResolver } = defaultResolvers,
): Promise<DanglingSmartAlbumReferences> {
  const findMissing = async (ids: string[] | null | undefined, resolve: ReferenceResolver) => {
    const unique = [...new Set(ids)];
    const exists = await Promise.all(unique.map((id) => resolve(id)));
    return unique.filter((_, index) => exists[index] === false);
  };

  const [personIds, tagIds] = await Promise.all([
    findMissing(filter?.personIds, resolvers.person),
    findMissing(filter?.tagIds, resolvers.tag),
  ]);
  return { personIds, tagIds };
}

export const hasDanglingSmartAlbumReferences = ({ personIds, tagIds }: DanglingSmartAlbumReferences) =>
  personIds.length > 0 || tagIds.length > 0;

/**
 * `filter` without the given person/tag ids (the owner's explicit repair). A list that ends up
 * empty is dropped, since an empty list is no criterion. Note that this broadens the album:
 * the condition matched nothing before.
 */
export function removeSmartAlbumReferences(
  filter: SmartAlbumFilter,
  { personIds, tagIds }: DanglingSmartAlbumReferences,
): SmartAlbumFilter {
  const result: SmartAlbumFilter = { ...filter };

  if (result.personIds) {
    const remaining = result.personIds.filter((id) => !personIds.includes(id));
    if (remaining.length > 0) {
      result.personIds = remaining;
    } else {
      delete result.personIds;
    }
  }

  if (result.tagIds) {
    const remaining = result.tagIds.filter((id) => !tagIds.includes(id));
    if (remaining.length > 0) {
      result.tagIds = remaining;
    } else {
      delete result.tagIds;
    }
  }

  return result;
}
