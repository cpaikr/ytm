"""Read XLSX structure independently using only the Python standard library."""
import json
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": MAIN}


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, "invalid ZIP entry checksum"
        names = archive.namelist()
        assert not any("externalLink" in name or "vbaProject" in name for name in names)
        for name in names:
            if name.endswith(".rels"):
                relations = ET.fromstring(archive.read(name))
                assert all(item.get("TargetMode") != "External" for item in relations), "external relationship"
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.get("Id"): item.get("Target") for item in relations}
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        styles = ET.fromstring(archive.read("xl/styles.xml"))
        formats = {item.get("numFmtId"): item.get("formatCode") for item in styles.findall("s:numFmts/s:numFmt", NS)}
        xfs = styles.findall("s:cellXfs/s:xf", NS)
        fonts = styles.findall("s:fonts/s:font", NS)
        fills = styles.findall("s:fills/s:fill", NS)
        sheets = []
        for info in workbook.findall("s:sheets/s:sheet", NS):
            assert info.get("state", "visible") == "visible", "hidden worksheet"
            target = targets[info.get(f"{{{REL}}}id")]
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            xml = ET.fromstring(archive.read(target))
            assert xml.find(".//s:f", NS) is None, "formula cell"
            assert xml.find("s:mergeCells", NS) is None, "merged cells"
            assert xml.find("s:hyperlinks", NS) is None, "hyperlinks"
            cells = {}
            for cell in xml.findall("s:sheetData/s:row/s:c", NS):
                kind = cell.get("t", "n")
                value = cell.findtext("s:v", default=None, namespaces=NS)
                if kind == "s":
                    value = strings[int(value)]
                    kind = "text"
                elif kind == "inlineStr":
                    value = "".join(cell.find("s:is", NS).itertext())
                    kind = "text"
                elif kind == "b":
                    value = value == "1"
                    kind = "boolean"
                elif value is None:
                    kind = "empty"
                elif kind == "n":
                    value = float(value)
                    kind = "number"
                else:
                    raise AssertionError(f"unexpected cell type: {kind}")
                xf = xfs[int(cell.get("s", "0"))]
                font = fonts[int(xf.get("fontId", "0"))]
                fill = fills[int(xf.get("fillId", "0"))]
                alignment = xf.find("s:alignment", NS)
                cells[cell.get("r")] = {
                    "type": kind, "value": value,
                    "format": formats.get(xf.get("numFmtId"), xf.get("numFmtId")),
                    "bold": font.find("s:b", NS) is not None,
                    "fill": fill.find("s:patternFill/s:fgColor", NS).attrib if fill.find("s:patternFill/s:fgColor", NS) is not None else None,
                    "wrap": alignment is not None and alignment.get("wrapText") == "1",
                }
            pane = xml.find("s:sheetViews/s:sheetView/s:pane", NS)
            autofilter = xml.find("s:autoFilter", NS)
            sheets.append({
                "name": info.get("name"), "cells": cells,
                "pane": pane.attrib if pane is not None else None,
                "filter": autofilter.get("ref") if autofilter is not None else None,
                "columns": [column.attrib for column in xml.findall("s:cols/s:col", NS)],
            })
        return {"sheets": sheets}


if __name__ == "__main__":
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False, allow_nan=False))
