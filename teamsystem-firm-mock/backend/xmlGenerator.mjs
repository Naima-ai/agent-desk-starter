// backend/xmlGenerator.mjs — turns one invoice line into FatturaPA-shaped XML.
// Structured after the real FatturaPA element names and nesting
// (FatturaElettronicaHeader/Body, CedentePrestatore, CessionarioCommittente,
// DatiBeniServizi, DatiRiepilogo) so it reads like a real e-invoice — but it
// has NOT been run through the official XSD (Provv. AdE 89757/2018,
// Allegato A). Validating that for real is Il Verificatore's job, once it
// exists; this is "shaped like," not "certified as."
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function toFatturaPaXml(client, line) {
  const rate = line.net ? Math.round((line.vat / line.net) * 100 * 100) / 100 : 0;
  const gross = Math.round((line.net + line.vat) * 100) / 100;
  const docNumber = line.docNumber || `FT-${client.period}-${line.id}`;
  const date = line.date || line.invoiceDate || "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${esc(client.piva)}</IdCodice></IdTrasmittente>
      <ProgressivoInvio>${esc(line.id)}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>0000000</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${esc(line.piva || client.piva)}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${esc(line.supplier)}</Denominazione></Anagrafica>
        <RegimeFiscale>${client.regime === "forfettario" ? "RF19" : "RF01"}</RegimeFiscale>
      </DatiAnagrafici>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${esc(client.vatGroup?.groupCf && line.counterpartyCfUsed === client.vatGroup.groupCf ? client.vatGroup.groupCf : client.piva)}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${esc(client.name)}</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>${esc(date)}</Data>
        <Numero>${esc(docNumber)}</Numero>
        <ImportoTotaleDocumento>${gross.toFixed(2)}</ImportoTotaleDocumento>
        ${line.splitPayment ? "<EsigibilitaIVA>S</EsigibilitaIVA>" : ""}
        ${line.legalWording ? `<Causale>${esc(line.legalWording)}</Causale>` : ""}
      </DatiGeneraliDocumento>
      ${line.supplyDate ? `<DatiOrdineAcquisto><DataDocumento>${esc(line.supplyDate)}</DataDocumento></DatiOrdineAcquisto>` : ""}
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee>
        <NumeroLinea>${line.lineNumber ?? 1}</NumeroLinea>
        <Descrizione>${esc(line.desc)}</Descrizione>
        <PrezzoUnitario>${Number(line.net).toFixed(2)}</PrezzoUnitario>
        <PrezzoTotale>${Number(line.net).toFixed(2)}</PrezzoTotale>
        <AliquotaIVA>${rate.toFixed(2)}</AliquotaIVA>
        ${line.natura ? `<Natura>${esc(line.natura)}</Natura>` : ""}
      </DettaglioLinee>
      <DatiRiepilogo>
        <AliquotaIVA>${rate.toFixed(2)}</AliquotaIVA>
        ${line.natura ? `<Natura>${esc(line.natura)}</Natura>` : ""}
        <ImponibileImporto>${Number(line.net).toFixed(2)}</ImponibileImporto>
        <Imposta>${Number(line.vat).toFixed(2)}</Imposta>
      </DatiRiepilogo>
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`;
}
