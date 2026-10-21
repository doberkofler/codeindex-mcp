import {type DocumentId} from './reexport.js';

export const normalizeInvoiceId = (invoiceId: DocumentId): string => invoiceId.trim();
