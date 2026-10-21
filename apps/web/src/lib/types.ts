export type EstablishmentType =
  | 'PATISSERIE'
  | 'RESTAURANT'
  | 'PATISSERIE_RESTAURANT'
  | 'BOULANGERIE_PATISSERIE'
  | 'BOULANGERIE_PATISSERIE_RESTAURANT';

export const ESTABLISHMENT_TYPES: Record<EstablishmentType, string> = {
  PATISSERIE: 'Pâtisserie',
  RESTAURANT: 'Restaurant',
  PATISSERIE_RESTAURANT: 'Pâtisserie + Restaurant',
  BOULANGERIE_PATISSERIE: 'Boulangerie + Pâtisserie',
  BOULANGERIE_PATISSERIE_RESTAURANT: 'Boulangerie + Pâtisserie + Restaurant',
};

export interface Me {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  mustChangePassword: boolean;
  company: { id: string; name: string; currency: string; logoUrl: string | null };
  globalPermissions: string[];
  establishments: {
    id: string;
    code: string;
    name: string;
    type: EstablishmentType;
    city: string | null;
    permissions: string[];
  }[];
}

export interface Establishment {
  id: string;
  code: string;
  name: string;
  type: EstablishmentType;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  isActive: boolean;
  modules: { restaurant: boolean; patisserie: boolean; boulangerie: boolean; production: boolean };
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  assignmentCount: number;
}

export interface Permission {
  code: string;
  module: string;
  label: string;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  userRoles: {
    id: string;
    establishmentId: string | null;
    role: { id: string; code: string; name: string };
    establishment: { id: string; code: string; name: string } | null;
  }[];
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues: unknown;
  newValues: unknown;
  reason: string | null;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; fullName: string; email: string } | null;
  establishment: { id: string; name: string } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
