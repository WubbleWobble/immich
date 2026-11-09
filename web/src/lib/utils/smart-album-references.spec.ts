import {
  findDanglingSmartAlbumReferences,
  hasDanglingSmartAlbumReferences,
  removeSmartAlbumReferences,
  type ReferenceResolver,
} from '$lib/utils/smart-album-references';

const resolverFor =
  (existing: string[], unknown: string[] = []): ReferenceResolver =>
  (id) =>
    Promise.resolve(unknown.includes(id) ? undefined : existing.includes(id));

describe('findDanglingSmartAlbumReferences', () => {
  it('flags only ids that resolve as gone', async () => {
    const result = await findDanglingSmartAlbumReferences(
      { personIds: ['p1', 'p2', 'p3'], tagIds: ['t1', 't2'] },
      { person: resolverFor(['p1'], ['p3']), tag: resolverFor(['t1']) },
    );
    expect(result).toEqual({ personIds: ['p2'], tagIds: ['t2'] });
    expect(hasDanglingSmartAlbumReferences(result)).toBe(true);
  });

  it('has nothing to resolve for untagged, absent or empty filters', async () => {
    const resolvers = { person: vi.fn(resolverFor([])), tag: vi.fn(resolverFor([])) };
    const result = await findDanglingSmartAlbumReferences({ tagIds: null }, resolvers);
    expect(result).toEqual({ personIds: [], tagIds: [] });
    expect(hasDanglingSmartAlbumReferences(result)).toBe(false);
    await findDanglingSmartAlbumReferences(null, resolvers);
    expect(resolvers.person).not.toHaveBeenCalled();
    expect(resolvers.tag).not.toHaveBeenCalled();
  });
});

describe('removeSmartAlbumReferences', () => {
  it('removes the given ids and drops lists that end up empty', () => {
    expect(
      removeSmartAlbumReferences(
        { personIds: ['p1', 'p2'], tagIds: ['t1'], city: null },
        { personIds: ['p1'], tagIds: ['t1'] },
      ),
    ).toEqual({ personIds: ['p2'], city: null });
  });

  it('leaves an untagged (null) condition alone', () => {
    expect(removeSmartAlbumReferences({ tagIds: null }, { personIds: [], tagIds: ['t1'] })).toEqual({ tagIds: null });
  });
});
