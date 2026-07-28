import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Health check. Público: el JwtAuthGuard es global y si no exigiría token. */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
