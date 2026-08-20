import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const LocksResponseSchema = z
  .object({
    lockedAlbumIds: z.array(z.uuidv4()).describe('Albums the requesting user has locked'),
    lockedContainerIds: z.array(z.uuidv4()).describe('Folders the requesting user has locked'),
  })
  .meta({ id: 'LocksResponseDto' });

export class LocksResponseDto extends createZodDto(LocksResponseSchema) {}

const MoveToLockedAlbumSchema = z
  .object({
    albumId: z.uuidv4().describe('The locked destination album (must be locked by the requesting user)'),
    assetIds: z.array(z.uuidv4()).min(1).max(5000).describe('Assets to move into the locked album'),
  })
  .meta({ id: 'MoveToLockedAlbumDto' });

export class MoveToLockedAlbumDto extends createZodDto(MoveToLockedAlbumSchema) {}

const MoveToLockedAlbumResponseSchema = z
  .object({
    moved: z.array(z.uuidv4()).describe('Fully moved: in the locked album and no longer visible anywhere else'),
    stillVisible: z
      .array(z.uuidv4())
      .describe('In the locked album, but still visible elsewhere (unremovable membership or a matching saved search)'),
    failed: z
      .array(z.uuidv4())
      .describe('Never made it into the locked album; existing memberships were left untouched'),
  })
  .meta({ id: 'MoveToLockedAlbumResponseDto' });

export class MoveToLockedAlbumResponseDto extends createZodDto(MoveToLockedAlbumResponseSchema) {}
