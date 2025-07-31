import { 
  CreateRecurringChargePublicRequest, 
  ChargeResponse, 
  RecurringChargeResponse, 
  AuthorizeRecurringChargePublicResponse 
} from './api-requests';
import { 
  CreateRecurringChargeRequest, 
  PixCharge, 
  RecurringPixCharge, 
  AuthorizeRecurringChargeResponse 
} from './inter-api';

export function mapPublicToInterRecurringCharge(publicRequest: CreateRecurringChargePublicRequest): CreateRecurringChargeRequest {
  return {
    calendario: {
      dataDeVencimento: publicRequest.calendar.dueDate,
      validadeAposVencimento: publicRequest.calendar.validityAfterDue
    },
    devedor: {
      cpf: publicRequest.debtor.cpf,
      cnpj: publicRequest.debtor.cnpj,
      nome: publicRequest.debtor.name,
      logradouro: publicRequest.debtor.address,
      cidade: publicRequest.debtor.city,
      uf: publicRequest.debtor.state,
      cep: publicRequest.debtor.zipCode
    },
    valor: {
      original: publicRequest.value.original,
      modalidadeAlteracao: publicRequest.value.changeMode
    },
    chave: publicRequest.key,
    solicitacaoPagador: publicRequest.payerRequest,
    infoAdicionais: publicRequest.additionalInfo?.map(info => ({
      nome: info.name,
      valor: info.value
    }))
  };
}

export function mapInterToPublicCharge(interCharge: PixCharge): ChargeResponse {
  return {
    calendar: {
      creation: interCharge.calendario.criacao,
      expiration: interCharge.calendario.expiracao
    },
    txid: interCharge.txid,
    revision: interCharge.revisao,
    location: {
      id: interCharge.loc.id,
      location: interCharge.loc.location,
      chargeType: interCharge.loc.tipoCob,
      creation: interCharge.loc.criacao
    },
    status: mapInterStatusToPublic(interCharge.status),
    debtor: interCharge.devedor ? {
      cpf: interCharge.devedor.cpf,
      cnpj: interCharge.devedor.cnpj,
      name: interCharge.devedor.nome
    } : undefined,
    value: {
      original: interCharge.valor.original
    },
    key: interCharge.chave,
    payerRequest: interCharge.solicitacaoPagador,
    pixCopyPaste: interCharge.pixCopiaECola
  };
}

export function mapInterToPublicRecurringCharge(interCharge: RecurringPixCharge): RecurringChargeResponse {
  return {
    calendar: {
      dueDate: interCharge.calendario.dataDeVencimento,
      validityAfterDue: interCharge.calendario.validadeAposVencimento,
      creation: interCharge.calendario.criacao
    },
    txid: interCharge.txid,
    revision: interCharge.revisao,
    location: interCharge.loc ? {
      id: interCharge.loc.id,
      location: interCharge.loc.location,
      chargeType: interCharge.loc.tipoCob,
      creation: interCharge.loc.criacao
    } : undefined,
    status: interCharge.status ? mapInterRecurringStatusToPublic(interCharge.status) : undefined,
    debtor: {
      cpf: interCharge.devedor.cpf,
      cnpj: interCharge.devedor.cnpj,
      name: interCharge.devedor.nome,
      address: interCharge.devedor.logradouro,
      city: interCharge.devedor.cidade,
      state: interCharge.devedor.uf,
      zipCode: interCharge.devedor.cep
    },
    receiver: interCharge.recebedor ? {
      address: interCharge.recebedor.logradouro,
      city: interCharge.recebedor.cidade,
      state: interCharge.recebedor.uf,
      zipCode: interCharge.recebedor.cep,
      cnpj: interCharge.recebedor.cnpj,
      name: interCharge.recebedor.nome
    } : undefined,
    value: {
      original: interCharge.valor.original,
      changeMode: interCharge.valor.modalidadeAlteracao
    },
    key: interCharge.chave,
    payerRequest: interCharge.solicitacaoPagador,
    additionalInfo: interCharge.infoAdicionais?.map(info => ({
      name: info.nome,
      value: info.valor
    })),
    pixCopyPaste: interCharge.pixCopiaECola
  };
}

export function mapInterToPublicAuthorizeResponse(interResponse: AuthorizeRecurringChargeResponse): AuthorizeRecurringChargePublicResponse {
  return {
    txid: interResponse.txid,
    status: interResponse.status === 'AUTORIZADA' ? 'AUTHORIZED' : 'DENIED',
    revision: interResponse.revisao
  };
}

function mapInterStatusToPublic(status: string): 'ACTIVE' | 'COMPLETED' | 'REMOVED_BY_USER' | 'REMOVED_BY_PSP' {
  switch (status) {
    case 'ATIVA': return 'ACTIVE';
    case 'CONCLUIDA': return 'COMPLETED';
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR': return 'REMOVED_BY_USER';
    case 'REMOVIDA_PELO_PSP': return 'REMOVED_BY_PSP';
    default: return 'ACTIVE';
  }
}

function mapInterRecurringStatusToPublic(status: string): 'PROCESSING' | 'ACTIVE' | 'COMPLETED' | 'REMOVED_BY_USER' | 'REMOVED_BY_PSP' {
  switch (status) {
    case 'EM_PROCESSAMENTO': return 'PROCESSING';
    case 'ATIVA': return 'ACTIVE';
    case 'CONCLUIDA': return 'COMPLETED';
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR': return 'REMOVED_BY_USER';
    case 'REMOVIDA_PELO_PSP': return 'REMOVED_BY_PSP';
    default: return 'ACTIVE';
  }
} 