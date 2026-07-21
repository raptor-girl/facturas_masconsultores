export type UfProviderName = 'sii.cl' | 'mindicador.cl';

export type UfProviderResult =
  | {
      status: 'found';
      value: string;
      sourceReference: string;
    }
  | { status: 'not-published' };

export interface UfProvider {
  readonly name: UfProviderName;
  fetch(date: string): Promise<UfProviderResult>;
}

export type UfProviderFailureKind = 'temporary' | 'invalid-response' | 'not-found';

export class UfProviderError extends Error {
  constructor(
    readonly provider: UfProviderName,
    readonly kind: UfProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'UfProviderError';
  }
}
