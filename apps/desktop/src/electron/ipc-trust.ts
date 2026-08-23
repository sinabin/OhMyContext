export interface IpcSenderEvidence {
  trustedWebContentsId: number | undefined;
  senderWebContentsId: number;
  isMainFrame: boolean;
  senderUrl: string;
  expectedUrl: string;
}

export function isTrustedIpcSender(evidence: IpcSenderEvidence): boolean {
  return evidence.trustedWebContentsId !== undefined &&
    evidence.senderWebContentsId === evidence.trustedWebContentsId &&
    evidence.isMainFrame &&
    evidence.senderUrl === evidence.expectedUrl;
}
