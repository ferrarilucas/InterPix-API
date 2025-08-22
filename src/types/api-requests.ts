// Public API request/response interfaces (English)
export interface CreateChargeRequest {
  value: number;
  internalId: string;
  callbackUrl?: string;
  taxId?: string;
}

export interface CreateRecurringChargePublicRequest {
  calendar: {
    dueDate: string;
    validityAfterDue?: number;
  };
  debtor: {
    cpf?: string;
    cnpj?: string;
    name: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  };
  value: {
    original: string;
    changeMode?: number;
  };
  key: string;
  payerRequest?: string;
  additionalInfo?: Array<{
    name: string;
    value: string;
  }>;
}

export interface ChargeResponse {
  calendar: {
    creation: string;
    expiration: number;
  };
  txid: string;
  revision: number;
  location: {
    id: number;
    location: string;
    chargeType: string;
    creation: string;
  };
  status: 'ACTIVE' | 'COMPLETED' | 'REMOVED_BY_USER' | 'REMOVED_BY_PSP';
  debtor?: {
    cpf?: string;
    cnpj?: string;
    name: string;
  };
  value: {
    original: string;
  };
  key: string;
  payerRequest?: string;
  pixCopyPaste?: string;
}

export interface RecurringChargeResponse {
  calendar: {
    dueDate: string;
    validityAfterDue?: number;
    creation?: string;
  };
  txid?: string;
  revision?: number;
  location?: {
    id: number;
    location: string;
    chargeType: string;
    creation: string;
  };
  status?: 'PROCESSING' | 'ACTIVE' | 'COMPLETED' | 'REMOVED_BY_USER' | 'REMOVED_BY_PSP';
  debtor: {
    cpf?: string;
    cnpj?: string;
    name: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  };
  receiver?: {
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    cnpj?: string;
    name?: string;
  };
  value: {
    original: string;
    changeMode?: number;
  };
  key: string;
  payerRequest?: string;
  additionalInfo?: Array<{
    name: string;
    value: string;
  }>;
  pixCopyPaste?: string;
}

export interface AuthorizeRecurringChargePublicResponse {
  txid: string;
  status: 'AUTHORIZED' | 'DENIED';
  revision?: number;
} 