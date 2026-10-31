/**
 * What both ends of SOAP share: the version/namespace pair, the record shape and the
 * envelope.
 *
 * Separate module so the client (`soap.ts`) and the server (`soap-server.ts`) can both use
 * them without importing each other.
 */

import { serializeXml, xmlElement, type XmlElement, type XmlRecord, type XmlValue } from './xml.ts';

export type SoapVersion = '1.1' | '1.2';

/** The envelope namespace, which is also how a version mismatch is detected. */
export const SOAP_NAMESPACE: Readonly<Record<SoapVersion, string>> = Object.freeze({
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
});

/** A decoded SOAP body: leaves are strings, repeats are arrays. No coercion (VLD-007). */
export type SoapRecord = XmlRecord;
export type { XmlRecord as SoapObject, XmlValue as SoapValue };

/** `<soap:Envelope><soap:Body>…</soap:Body></soap:Envelope>`, with no Header unless used. */
export function envelope(version: SoapVersion, body: XmlElement, header?: XmlElement): string {
  const root = xmlElement('soap:Envelope', {
    attributes: { 'xmlns:soap': SOAP_NAMESPACE[version] },
    children: [
      // A header element declares its own prefixes; it must not inherit the body's
      // default namespace, which would put `UsernameToken` in the SOAP namespace.
      ...(header === undefined ? [] : [xmlElement('soap:Header', { children: [header] })]),
      xmlElement('soap:Body', { children: [withNamespace(body, version)] }),
    ],
  });
  return `<?xml version="1.0" encoding="utf-8"?>${serializeXml(root)}`;
}

export function withNamespace(element: XmlElement, version: SoapVersion): XmlElement {
  const attributes = element.attributes;
  if (Object.hasOwn(attributes, 'xmlns')) return element;
  return {
    ...element,
    attributes: { xmlns: SOAP_NAMESPACE[version], ...attributes },
  };
}
