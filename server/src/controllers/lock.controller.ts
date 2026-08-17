import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { LocksResponseDto } from 'src/dtos/lock.dto';
import { ApiTag } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { LockService } from 'src/services/lock.service';

@ApiTags(ApiTag.Locks)
@Controller('locks')
export class LockController {
  constructor(private service: LockService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'Get the locks of the requesting user (requires an elevated session)',
    history: new HistoryBuilder().added('v2').alpha('v2'),
  })
  getLocks(@Auth() auth: AuthDto): Promise<LocksResponseDto> {
    return this.service.getLocks(auth);
  }
}
