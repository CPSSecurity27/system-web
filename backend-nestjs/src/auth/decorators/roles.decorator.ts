import { SetMetadata } from '@nestjs/common';
import { AccountType, UserRole } from '../../common/enums';

export const REQUIRED_MEMBERSHIP = 'auth:membership';

/**
 * Un rol NO significa lo mismo en toda cuenta: ADMIN en una COMPANY es el
 * administrador global del sistema; ADMIN en una HOME es el titular de una
 * vivienda. Por eso los permisos se piden SIEMPRE como el par (tipo de cuenta,
 * rol), nunca como un rol suelto.
 *
 *   @RequireMembership({ accountType: COMPANY, roles: [ADMIN] })  // admin de CPS
 */
export interface MembershipRequirement {
  accountType: AccountType;
  roles: UserRole[];
}

export const RequireMembership = (...requirements: MembershipRequirement[]) =>
  SetMetadata(REQUIRED_MEMBERSHIP, requirements);
