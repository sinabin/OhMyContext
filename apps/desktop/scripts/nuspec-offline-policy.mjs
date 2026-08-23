import { DOMParser } from "@xmldom/xmldom";

const MAX_NUSPEC_BYTES = 64 * 1024;
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const ALLOWED_NUSPEC_NAMESPACES = new Set([
  "http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd",
  "http://schemas.microsoft.com/packaging/2011/08/nuspec.xsd",
]);
const HTTP_URL = /https?:\/\//iu;

export function assertOfflineNuspecMetadata(nuspecText) {
  if (
    typeof nuspecText !== "string" ||
    Buffer.byteLength(nuspecText, "utf8") === 0 ||
    Buffer.byteLength(nuspecText, "utf8") > MAX_NUSPEC_BYTES ||
    /<!DOCTYPE\b|<!ENTITY\b/iu.test(nuspecText)
  ) {
    throw new Error("Squirrel NuSpec metadata is invalid.");
  }

  let document;
  try {
    document = new DOMParser({
      onError(level, message) {
        throw new Error(`${level}: ${message}`);
      },
    }).parseFromString(nuspecText, "application/xml");
  } catch {
    throw new Error("Squirrel NuSpec metadata is invalid.");
  }

  const root = document.documentElement;
  if (
    !root ||
    root.localName !== "package" ||
    !ALLOWED_NUSPEC_NAMESPACES.has(root.namespaceURI ?? "")
  ) {
    throw new Error("Squirrel NuSpec metadata is invalid.");
  }

  let allowedNamespaceDeclarations = 0;
  const elements = [root];
  while (elements.length > 0) {
    const element = elements.pop();
    if (!element) continue;
    if (element.localName.toLowerCase() === "iconurl") {
      throw new Error(
        "Squirrel package metadata would make installation depend on an external icon download.",
      );
    }

    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const isAllowedRootNamespace =
        element === root &&
        attribute.namespaceURI === XMLNS_NAMESPACE &&
        ALLOWED_NUSPEC_NAMESPACES.has(attribute.value);
      if (isAllowedRootNamespace) {
        allowedNamespaceDeclarations += 1;
      } else if (HTTP_URL.test(attribute.value)) {
        throw new Error(
          "Squirrel package metadata contains an external URL.",
        );
      }
    }

    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === child.ELEMENT_NODE) {
        elements.push(child);
      } else if (
        (child.nodeType === child.TEXT_NODE ||
          child.nodeType === child.CDATA_SECTION_NODE) &&
        HTTP_URL.test(child.nodeValue ?? "")
      ) {
        throw new Error("Squirrel package metadata contains an external URL.");
      }
    }
  }

  if (allowedNamespaceDeclarations < 1) {
    throw new Error("Squirrel NuSpec namespace declaration is invalid.");
  }
}
