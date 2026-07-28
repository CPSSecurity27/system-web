import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './entities/department.entity';
import { Locality } from './entities/locality.entity';
import { Province } from './entities/province.entity';

/**
 * Solo lectura. La geografía no se administra: no hay create/update/delete.
 * Los datos entran únicamente por GeographySyncService (ver docs/geografia.md).
 *
 * Estos endpoints existen para poblar los combos en cascada del panel al dar de
 * alta un barrio: provincia -> departamento -> localidad.
 */
@Injectable()
export class GeographyService {
  constructor(
    @InjectRepository(Province)
    private readonly provinces: Repository<Province>,
    @InjectRepository(Department)
    private readonly departments: Repository<Department>,
    @InjectRepository(Locality)
    private readonly localities: Repository<Locality>,
  ) {}

  findProvinces(): Promise<Province[]> {
    return this.provinces.find({ order: { name: 'ASC' } });
  }

  async findDepartmentsByProvince(provinceId: number): Promise<Department[]> {
    // Se valida que la provincia exista: si no, un id inventado devolvería []
    // y el front no podría distinguir "no hay" de "te equivocaste de id".
    await this.getProvinceOrFail(provinceId);

    return this.departments.find({
      where: { provinceId },
      order: { name: 'ASC' },
    });
  }

  async findLocalitiesByDepartment(departmentId: number): Promise<Locality[]> {
    await this.getDepartmentOrFail(departmentId);

    return this.localities.find({
      where: { departmentId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Buscador por nombre para un autocomplete. Trae el árbol para desambiguar
   * (hay 5 "Villa Nueva" en el país).
   *
   * Insensible a mayúsculas Y a acentos: "cordoba" encuentra "Córdoba" y
   * "rio cuarto" encuentra "Río Cuarto". Un ILIKE pelado NO hace lo segundo, y
   * nadie escribe tildes en el teclado del celular.
   *
   * La expresión tiene que ser idéntica a la del índice idx_locality_name_search
   * o Postgres lo ignora y hace seq scan.
   */
  searchLocalities(search: string, limit: number): Promise<Locality[]> {
    return this.localities
      .createQueryBuilder('locality')
      .innerJoinAndSelect('locality.department', 'department')
      .innerJoinAndSelect('department.province', 'province')
      .where(
        'immutable_unaccent(lower(locality.name)) LIKE immutable_unaccent(lower(:search))',
        { search: `%${search}%` },
      )
      .orderBy('locality.name', 'ASC')
      .take(limit)
      .getMany();
  }

  async getLocality(id: number): Promise<Locality> {
    const locality = await this.localities.findOne({
      where: { id },
      relations: { department: { province: true } },
    });
    if (!locality) {
      throw new NotFoundException(`No existe la localidad ${id}`);
    }
    return locality;
  }

  private async getProvinceOrFail(id: number): Promise<Province> {
    const province = await this.provinces.findOne({ where: { id } });
    if (!province) {
      throw new NotFoundException(`No existe la provincia ${id}`);
    }
    return province;
  }

  private async getDepartmentOrFail(id: number): Promise<Department> {
    const department = await this.departments.findOne({ where: { id } });
    if (!department) {
      throw new NotFoundException(`No existe el departamento ${id}`);
    }
    return department;
  }
}
