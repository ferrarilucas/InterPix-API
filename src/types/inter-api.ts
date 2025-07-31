export interface PixCalendar {
  criacao: string;
  expiracao: number;
}

export interface PixValue {
  original: string;
}

export interface PixLocation {
  id: number;
  location: string;
  tipoCob: string;
  criacao: string;
}

export interface PixCharge {
  calendario: PixCalendar;
  txid: string;
  revisao: number;
  loc: PixLocation;
  location: string;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP';
  devedor?: {
    cpf?: string;
    cnpj?: string;
    nome: string;
  };
  valor: PixValue;
  chave: string;
  solicitacaoPagador?: string;
  pixCopiaECola?: string;
}

export interface RecurringPixCalendar {
  dataDeVencimento: string;
  validadeAposVencimento?: number;
  criacao?: string;
}

export interface RecurringPixValue {
  original: string;
  modalidadeAlteracao?: number;
}

export interface RecurringPixDebtor {
  cpf?: string;
  cnpj?: string;
  nome: string;
  logradouro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
}

export interface RecurringPixCharge {
  calendario: RecurringPixCalendar;
  txid?: string;
  revisao?: number;
  loc?: PixLocation;
  location?: string;
  status?: 'EM_PROCESSAMENTO' | 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP';
  devedor: RecurringPixDebtor;
  recebedor?: {
    logradouro?: string;
    cidade?: string;
    uf?: string;
    cep?: string;
    cnpj?: string;
    nome?: string;
  };
  valor: RecurringPixValue;
  chave: string;
  solicitacaoPagador?: string;
  infoAdicionais?: Array<{
    nome: string;
    valor: string;
  }>;
  pixCopiaECola?: string;
}

export interface CreateRecurringChargeRequest {
  calendario: {
    dataDeVencimento: string;
    validadeAposVencimento?: number;
  };
  devedor: {
    cpf?: string;
    cnpj?: string;
    nome: string;
    logradouro?: string;
    cidade?: string;
    uf?: string;
    cep?: string;
  };
  valor: {
    original: string;
    modalidadeAlteracao?: number;
  };
  chave: string;
  solicitacaoPagador?: string;
  infoAdicionais?: Array<{
    nome: string;
    valor: string;
  }>;
}

export interface AuthorizeRecurringChargeResponse {
  txid: string;
  status: 'AUTORIZADA' | 'NEGADA';
  revisao?: number;
} 