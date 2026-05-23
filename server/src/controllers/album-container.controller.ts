import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AlbumContainerResponseDto,
  AlbumContainerUserCreateDto,
  AlbumContainerUserUpdateDto,
  CreateAlbumContainerDto,
  UpdateAlbumContainerDto,
} from 'src/dtos/album-container.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { AlbumContainerService } from 'src/services/album-container.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.AlbumContainers)
@Controller('album-containers')
export class AlbumContainerController {
  constructor(private service: AlbumContainerService) {}

  @Post()
  @Authenticated()
  @Endpoint({ summary: 'Create folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  createAlbumContainer(
    @Auth() auth: AuthDto,
    @Body() dto: CreateAlbumContainerDto,
  ): Promise<AlbumContainerResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({ summary: 'Get folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  getAlbumContainer(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AlbumContainerResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated()
  @Endpoint({ summary: 'Rename or move folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  updateAlbumContainer(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateAlbumContainerDto,
  ): Promise<AlbumContainerResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ summary: 'Delete folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  deleteAlbumContainer(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }

  @Post(':id/users')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ summary: 'Add user to folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  addUserToAlbumContainer(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumContainerUserCreateDto,
  ): Promise<void> {
    return this.service.addUser(auth, id, dto);
  }

  @Put(':id/users/:userId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ summary: 'Update folder user role', history: new HistoryBuilder().added('v2').alpha('v2') })
  updateAlbumContainerUser(
    @Auth() auth: AuthDto,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: AlbumContainerUserUpdateDto,
  ): Promise<void> {
    return this.service.updateUser(auth, id, userId, dto);
  }

  @Delete(':id/users/:userId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ summary: 'Remove user from folder', history: new HistoryBuilder().added('v2').alpha('v2') })
  removeUserFromAlbumContainer(
    @Auth() auth: AuthDto,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.service.removeUser(auth, id, userId);
  }
}
