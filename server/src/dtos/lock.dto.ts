import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const LocksResponseSchema = z
  .object({
    lockedAlbumIds: z.array(z.uuidv4()).describe('Albums the requesting user has locked'),
    lockedContainerIds: z.array(z.uuidv4()).describe('Folders the requesting user has locked'),
  })
  .meta({ id: 'LocksResponseDto' });

export class LocksResponseDto extends createZodDto(LocksResponseSchema) {}
