import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/** Marca un endpoint como abierto. El JwtAuthGuard es global: sin esto, exige token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
