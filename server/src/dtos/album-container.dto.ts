import { createZodDto } from 'nestjs-zod';
import { UserResponseSchema } from 'src/dtos/user.dto';
import { AlbumUserRoleSchema } from 'src/enum';
import z from 'zod';

const CreateAlbumContainerSchema = z
  .object({
    name: z.string().min(1).describe('Folder name'),
    parentId: z.uuidv4().nullable().optional().describe('Parent folder ID (null for root)'),
  })
  .meta({ id: 'CreateAlbumContainerDto' });

const UpdateAlbumContainerSchema = z
  .object({
    name: z.string().min(1).optional().describe('Folder name'),
    parentId: z.uuidv4().nullable().optional().describe('Parent folder ID'),
  })
  .meta({ id: 'UpdateAlbumContainerDto' });

const AlbumContainerUserCreateSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumContainerUserCreateDto' });

const AlbumContainerUserUpdateSchema = z
  .object({
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumContainerUserUpdateDto' });

const AlbumContainerUserResponseSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema,
    user: UserResponseSchema,
  })
  .meta({ id: 'AlbumContainerUserResponseDto' });

const AlbumContainerResponseSchema = z
  .object({
    id: z.uuidv4().describe('Container ID'),
    name: z.string().describe('Folder name'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    parentId: z.uuidv4().nullable().describe('Parent folder ID (null for root)'),
    childContainerIds: z.array(z.uuidv4()).optional().describe('Direct child container IDs'),
    childAlbumIds: z.array(z.uuidv4()).optional().describe('Direct child album IDs'),
    thumbnailAssetIds: z
      .array(z.uuidv4())
      .max(4)
      .describe('Up to 4 recent descendant asset IDs for a folder mosaic thumbnail'),
    albumContainerUsers: z
      .array(AlbumContainerUserResponseSchema)
      .optional()
      .describe('Users this folder is shared with (owner not included); only present for the owner'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'AlbumContainerResponseDto' });

export class CreateAlbumContainerDto extends createZodDto(CreateAlbumContainerSchema) {}
export class UpdateAlbumContainerDto extends createZodDto(UpdateAlbumContainerSchema) {}
export class AlbumContainerUserCreateDto extends createZodDto(AlbumContainerUserCreateSchema) {}
export class AlbumContainerUserUpdateDto extends createZodDto(AlbumContainerUserUpdateSchema) {}
export class AlbumContainerUserResponseDto extends createZodDto(AlbumContainerUserResponseSchema) {}
export class AlbumContainerResponseDto extends createZodDto(AlbumContainerResponseSchema) {}
