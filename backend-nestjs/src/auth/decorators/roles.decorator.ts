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

/**
 * ¿Alguna membresía del usuario cumple alguno de los requisitos?
 *
 * Es la MISMA pregunta que hace `MembershipGuard`, extraída acá porque también
 * hay que hacerla sin un 403 de por medio: una pantalla que devuelve
 * `puedeEditar` tiene que responder exactamente lo que el guard va a responder
 * después. Dos implementaciones de esto se separan sin que nadie lo note y la
 * UI termina ofreciendo un botón que el backend rechaza.
 *
 * Alcanza con UNA membresía: un técnico de CPS que además es titular de su
 * vivienda tiene dos, y cada una le habilita cosas distintas.
 */
export function cumpleMembresia(
  memberships: { accountType: AccountType; role: UserRole }[],
  requirements: MembershipRequirement[],
): boolean {
  return memberships.some((m) =>
    requirements.some(
      (r) => r.accountType === m.accountType && r.roles.includes(m.role),
    ),
  );
}
