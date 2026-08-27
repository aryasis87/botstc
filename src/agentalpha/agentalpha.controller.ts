import { Controller, Post, Get, Body, Request, Query, UseGuards, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentAlphaService } from './agentalpha.service';

@UseGuards(JwtAuthGuard)
@Controller('agentalpha')
export class AgentAlphaController {
  constructor(private readonly svc: AgentAlphaService) {}

  @Post('start')
  @HttpCode(200)
  async start(@Request() req, @Body() body: any) {
    return this.svc.start(req.user.userId, {
      asset: body.asset,
      baseAmount: Number(body.baseAmount ?? body.amount ?? 0),
      isDemoAccount: !!body.isDemoAccount,
      currency: body.currency,
    });
  }

  @Post('stop')
  @HttpCode(200)
  async stop(@Request() req) {
    return this.svc.stop(req.user.userId);
  }

  @Get('status')
  async status(@Request() req) {
    return this.svc.getStatus(req.user.userId);
  }

  @Get('logs')
  async logs(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getLogs(req.user.userId, limit ? parseInt(limit, 10) : 100);
  }
}
