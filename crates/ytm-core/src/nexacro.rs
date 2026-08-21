use std::{borrow::Cow, collections::HashSet};

use indexmap::IndexMap;
use quick_xml::{
    encoding::Decoder,
    events::{attributes::Attribute, BytesStart, Event},
    name::{NamespaceResolver, QName, ResolveResult},
    reader::NsReader,
    XmlVersion,
};

use crate::{YtmError, MAX_ELEMENT_DEPTH, MAX_RESPONSE_BODY_BYTES};

const NAMESPACE: &[u8] = b"http://www.nexacroplatform.com/platform/dataset";

#[derive(Debug)]
pub struct DatasetResponse {
    pub rows: Vec<IndexMap<String, String>>,
}

enum Node {
    Root,
    Parameters,
    Parameter {
        id: String,
        text: String,
    },
    Dataset {
        selected: bool,
        rows_count: usize,
    },
    Rows {
        selected: bool,
    },
    Row {
        selected: bool,
        values: IndexMap<String, String>,
    },
    Col {
        selected: bool,
        id: String,
        text: String,
    },
    Other,
}

#[derive(Default)]
struct StructureState {
    stack: Vec<Node>,
    root_seen: bool,
    parameters_count: usize,
    selected_count: usize,
    selected_error: Option<YtmError>,
}

pub fn parse(bytes: &[u8], selected_dataset: &str) -> Result<DatasetResponse, YtmError> {
    if bytes.len() > MAX_RESPONSE_BODY_BYTES {
        return Err(YtmError::format(format!(
            "KIS-NET response exceeds the maximum body size of {MAX_RESPONSE_BODY_BYTES} bytes."
        )));
    }
    let bytes = strip_bom(bytes)?;
    let xml = std::str::from_utf8(bytes)
        .map_err(|_| YtmError::format("KIS-NET response is not valid UTF-8."))?;
    validate_xml_characters(xml)?;
    validate_declaration(bytes)?;

    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().check_end_names = true;
    reader.config_mut().allow_unmatched_ends = false;
    let mut buffer = Vec::new();
    let mut structure = StructureState::default();
    let mut root_closed = false;
    let mut declaration_seen = false;
    let mut document_start = true;
    let mut parameters = IndexMap::<String, String>::new();
    let mut rows = Vec::new();

    loop {
        let decoder = reader.decoder();
        let (resolution, event) = reader
            .read_resolved_event_into(&mut buffer)
            .map_err(|_| YtmError::format("KIS-NET response contains malformed Nexacro XML."))?;
        let namespace_ok = match resolution {
            ResolveResult::Bound(namespace) => {
                normalized_namespace(namespace.as_ref(), decoder)? == NAMESPACE
            }
            ResolveResult::Unbound | ResolveResult::Unknown(_) => false,
        };
        if matches!(&event, Event::Decl(_)) && !document_start {
            return Err(YtmError::format(
                "KIS-NET XML declaration is duplicated or misplaced.",
            ));
        }
        document_start = false;
        match event {
            Event::Decl(declaration) => {
                if declaration_seen || structure.root_seen {
                    return Err(YtmError::format(
                        "KIS-NET XML declaration is duplicated or misplaced.",
                    ));
                }
                declaration_seen = true;
                let version = declaration
                    .version()
                    .map_err(|_| YtmError::format("KIS-NET XML declaration is invalid."))?;
                if version.as_ref() != b"1.0" {
                    return Err(YtmError::format("KIS-NET response must use XML 1.0."));
                }
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(|_| {
                        YtmError::format("KIS-NET XML encoding declaration is invalid.")
                    })?;
                    if !encoding.as_ref().eq_ignore_ascii_case(b"UTF-8") {
                        return Err(YtmError::format(
                            "KIS-NET response must declare UTF-8 when an encoding is present.",
                        ));
                    }
                }
            }
            Event::DocType(_) => {
                return Err(YtmError::format(
                    "KIS-NET response must not contain a DOCTYPE declaration.",
                ))
            }
            Event::PI(_) => {
                return Err(YtmError::format(
                    "KIS-NET response must not contain processing instructions.",
                ))
            }
            Event::Start(element) => {
                start_node(
                    &element,
                    reader.decoder(),
                    reader.resolver(),
                    namespace_ok,
                    selected_dataset,
                    &mut structure,
                )?;
            }
            Event::Empty(element) => {
                start_node(
                    &element,
                    reader.decoder(),
                    reader.resolver(),
                    namespace_ok,
                    selected_dataset,
                    &mut structure,
                )?;
                finish_node(&mut structure, &mut parameters, &mut rows, &mut root_closed)?;
            }
            Event::End(_) => {
                finish_node(&mut structure, &mut parameters, &mut rows, &mut root_closed)?
            }
            Event::Text(text) => {
                let decoded = text
                    .xml10_content()
                    .map_err(|_| YtmError::format("KIS-NET response is not valid UTF-8."))?;
                append_text(&mut structure, &decoded)?;
            }
            Event::CData(text) => {
                let decoded = text
                    .xml10_content()
                    .map_err(|_| YtmError::format("KIS-NET response is not valid UTF-8."))?;
                append_text(&mut structure, &decoded)?;
            }
            Event::GeneralRef(reference) => {
                let reference = reference
                    .decode()
                    .map_err(|_| YtmError::format("KIS-NET response is not valid UTF-8."))?;
                let resolved = resolve_reference(&reference)?;
                append_text(&mut structure, &resolved)?;
            }
            Event::Comment(_) => {}
            Event::Eof => break,
        }
        buffer.clear();
    }

    if !structure.root_seen || !root_closed || !structure.stack.is_empty() {
        return Err(YtmError::format(
            "KIS-NET response must contain exactly one complete Root element.",
        ));
    }
    if structure.parameters_count != 1 {
        return Err(YtmError::format(
            "KIS-NET response must contain exactly one direct Parameters element.",
        ));
    }
    let error_code = parameters
        .get("ErrorCode")
        .ok_or_else(|| YtmError::format("KIS-NET response is missing ErrorCode."))?;
    if !is_status_integer(error_code) {
        return Err(YtmError::format(
            "KIS-NET ErrorCode is not a textual integer.",
        ));
    }
    if !is_zero_status(error_code) {
        let message = parameters
            .get("ErrorMsg")
            .or_else(|| parameters.get("ErrorMessage"))
            .cloned();
        return Err(YtmError::protocol(error_code.clone(), message));
    }
    if let Some(error) = structure.selected_error {
        return Err(error);
    }
    if structure.selected_count != 1 {
        return Err(YtmError::format(format!(
            "KIS-NET response must contain exactly one direct Dataset named {selected_dataset}."
        )));
    }
    Ok(DatasetResponse { rows })
}

fn start_node(
    element: &BytesStart<'_>,
    decoder: Decoder,
    resolver: &NamespaceResolver,
    namespace_ok: bool,
    selected_dataset: &str,
    state: &mut StructureState,
) -> Result<(), YtmError> {
    if !is_xml_qname(element.name().as_ref()) {
        return Err(YtmError::format(
            "KIS-NET response contains malformed Nexacro XML.",
        ));
    }
    let id = validated_id(element, decoder, resolver)?;
    let stack = &mut state.stack;
    if stack.len() + 1 > MAX_ELEMENT_DEPTH {
        return Err(YtmError::format(format!(
            "KIS-NET response exceeds the maximum XML element depth of {MAX_ELEMENT_DEPTH}."
        )));
    }
    if matches!(
        stack.last(),
        Some(Node::Parameter { .. } | Node::Col { .. })
    ) {
        return Err(YtmError::format(
            "KIS-NET scalar elements must not contain nested elements.",
        ));
    }
    let local = element.local_name();
    let name = local.as_ref();
    let node = if stack.is_empty() {
        if state.root_seen || name != b"Root" || !namespace_ok {
            return Err(YtmError::format(
                "KIS-NET response root or namespace is invalid.",
            ));
        }
        state.root_seen = true;
        Node::Root
    } else if matches!(stack.last(), Some(Node::Root)) && name == b"Parameters" && namespace_ok {
        state.parameters_count += 1;
        Node::Parameters
    } else if matches!(stack.last(), Some(Node::Parameters)) && name == b"Parameter" && namespace_ok
    {
        Node::Parameter {
            id: required_id(&id)?,
            text: String::new(),
        }
    } else if matches!(stack.last(), Some(Node::Root)) && name == b"Dataset" && namespace_ok {
        let id = required_id(&id)?;
        let selected = id == selected_dataset;
        if selected {
            state.selected_count += 1;
        }
        Node::Dataset {
            selected,
            rows_count: 0,
        }
    } else if let Some(Node::Dataset {
        selected,
        rows_count,
    }) = stack.last_mut()
    {
        if !*selected {
            Node::Other
        } else if name == b"Rows" && namespace_ok {
            *rows_count += 1;
            Node::Rows { selected: true }
        } else if name == b"ColumnInfo" && namespace_ok {
            Node::Other
        } else {
            record_selected_error(
                &mut state.selected_error,
                "KIS-NET selected Dataset has an invalid direct child.",
            );
            Node::Other
        }
    } else if matches!(stack.last(), Some(Node::Rows { selected: true }))
        && name == b"Row"
        && namespace_ok
    {
        Node::Row {
            selected: true,
            values: IndexMap::new(),
        }
    } else if matches!(stack.last(), Some(Node::Row { selected: true, .. }))
        && name == b"Col"
        && namespace_ok
    {
        match required_id(&id) {
            Ok(id) => Node::Col {
                selected: true,
                id,
                text: String::new(),
            },
            Err(error) => {
                state.selected_error.get_or_insert(error);
                Node::Other
            }
        }
    } else if matches!(
        stack.last(),
        Some(
            Node::Other
                | Node::Dataset {
                    selected: false,
                    ..
                }
                | Node::Rows { selected: false }
                | Node::Row {
                    selected: false,
                    ..
                }
        )
    ) {
        Node::Other
    } else if matches!(
        stack.last(),
        Some(Node::Rows { selected: true } | Node::Row { selected: true, .. })
    ) {
        record_selected_error(
            &mut state.selected_error,
            "KIS-NET selected Dataset rows or columns have invalid structure.",
        );
        Node::Other
    } else {
        return Err(YtmError::format(
            "KIS-NET response contains an invalid structural element.",
        ));
    };
    stack.push(node);
    Ok(())
}

fn finish_node(
    structure: &mut StructureState,
    parameters: &mut IndexMap<String, String>,
    rows: &mut Vec<IndexMap<String, String>>,
    root_closed: &mut bool,
) -> Result<(), YtmError> {
    let node = structure
        .stack
        .pop()
        .ok_or_else(|| YtmError::format("KIS-NET response contains an unmatched end element."))?;
    match node {
        Node::Root => *root_closed = true,
        Node::Parameter { id, text } => {
            if matches!(id.as_str(), "ErrorCode" | "ErrorMsg" | "ErrorMessage")
                && parameters.contains_key(&id)
            {
                return Err(YtmError::format(format!(
                    "KIS-NET response contains duplicate {id}."
                )));
            }
            parameters.insert(id, text);
        }
        Node::Dataset {
            selected: true,
            rows_count,
        } => {
            if rows_count != 1 {
                record_selected_error(
                    &mut structure.selected_error,
                    "KIS-NET selected Dataset must contain exactly one direct Rows element.",
                );
            }
        }
        Node::Row {
            selected: true,
            values,
        } => rows.push(values),
        Node::Col {
            selected: true,
            id,
            text,
        } => {
            let Some(Node::Row { values, .. }) = structure.stack.last_mut() else {
                record_selected_error(
                    &mut structure.selected_error,
                    "KIS-NET Col must be a direct Row child.",
                );
                return Ok(());
            };
            if values.insert(id.clone(), text).is_some() {
                structure.selected_error.get_or_insert_with(|| {
                    YtmError::format("KIS-NET row contains a duplicate column.")
                });
            }
        }
        _ => {}
    }
    Ok(())
}

fn append_text(structure: &mut StructureState, value: &str) -> Result<(), YtmError> {
    match structure.stack.last_mut() {
        Some(Node::Parameter { text, .. } | Node::Col { text, .. }) => {
            text.push_str(value);
            Ok(())
        }
        Some(
            Node::Other
            | Node::Dataset {
                selected: false, ..
            },
        ) => Ok(()),
        Some(
            Node::Dataset { selected: true, .. }
            | Node::Rows { selected: true }
            | Node::Row { selected: true, .. },
        ) if !value.trim().is_empty() => {
            record_selected_error(
                &mut structure.selected_error,
                "KIS-NET selected Dataset contains text outside a scalar column.",
            );
            Ok(())
        }
        _ if value.trim().is_empty() => Ok(()),
        _ => Err(YtmError::format(
            "KIS-NET response contains text outside a scalar element.",
        )),
    }
}

fn validated_id(
    element: &BytesStart<'_>,
    decoder: Decoder,
    resolver: &NamespaceResolver,
) -> Result<Option<String>, YtmError> {
    let mut expanded_names = HashSet::new();
    let mut id = None;
    for attribute in element.attributes() {
        let attribute = attribute
            .map_err(|_| YtmError::format("KIS-NET response contains invalid XML attributes."))?;
        if !is_xml_qname(attribute.key.as_ref()) || attribute.value.as_ref().contains(&b'<') {
            return Err(YtmError::format(
                "KIS-NET response contains invalid XML attributes.",
            ));
        }
        let value = attribute
            .decoded_and_normalized_value(XmlVersion::Explicit1_0, decoder)
            .map_err(|_| YtmError::format("KIS-NET response contains invalid XML attributes."))?;
        let (namespace, local_name) = resolver.resolve_attribute(attribute.key);
        let namespace = match namespace {
            ResolveResult::Unbound => None,
            ResolveResult::Bound(namespace) => {
                Some(normalized_namespace(namespace.as_ref(), decoder)?)
            }
            ResolveResult::Unknown(_) => {
                return Err(YtmError::format(
                    "KIS-NET response contains invalid XML attributes.",
                ));
            }
        };
        if !expanded_names.insert((namespace.clone(), local_name.as_ref().to_vec())) {
            return Err(YtmError::format(
                "KIS-NET response contains invalid XML attributes.",
            ));
        }
        if namespace.is_none() && local_name.as_ref() == b"id" {
            id = Some(value.into_owned());
        }
    }
    Ok(id)
}

fn normalized_namespace(bytes: &[u8], decoder: Decoder) -> Result<Vec<u8>, YtmError> {
    Attribute {
        key: QName(b"xmlns"),
        value: Cow::Borrowed(bytes),
    }
    .decoded_and_normalized_value(XmlVersion::Explicit1_0, decoder)
    .map(|value| value.into_owned().into_bytes())
    .map_err(|_| YtmError::format("KIS-NET response contains invalid XML attributes."))
}

fn required_id(id: &Option<String>) -> Result<String, YtmError> {
    if id.as_deref().is_some_and(|value| value.trim().is_empty()) {
        return Err(YtmError::format("KIS-NET element id must be nonempty."));
    }
    id.clone()
        .ok_or_else(|| YtmError::format("KIS-NET element is missing a required id attribute."))
}

fn is_xml_qname(bytes: &[u8]) -> bool {
    let Ok(name) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut parts = name.split(':');
    let Some(first) = parts.next() else {
        return false;
    };
    is_xml_ncname(first) && parts.next().is_none_or(is_xml_ncname) && parts.next().is_none()
}

fn is_xml_ncname(name: &str) -> bool {
    let mut characters = name.chars();
    characters.next().is_some_and(is_xml_name_start_character)
        && characters.all(is_xml_name_character)
}

fn is_xml_name_start_character(character: char) -> bool {
    matches!(
        character as u32,
        0x41..=0x5a
            | 0x5f
            | 0x61..=0x7a
            | 0xc0..=0xd6
            | 0xd8..=0xf6
            | 0xf8..=0x2ff
            | 0x370..=0x37d
            | 0x37f..=0x1fff
            | 0x200c..=0x200d
            | 0x2070..=0x218f
            | 0x2c00..=0x2fef
            | 0x3001..=0xd7ff
            | 0xf900..=0xfdcf
            | 0xfdf0..=0xfffd
            | 0x10000..=0xeffff
    )
}

fn is_xml_name_character(character: char) -> bool {
    is_xml_name_start_character(character)
        || matches!(
            character as u32,
            0x2d | 0x2e | 0x30..=0x39 | 0xb7 | 0x300..=0x36f | 0x203f..=0x2040
        )
}

fn strip_bom(bytes: &[u8]) -> Result<&[u8], YtmError> {
    const BOM: &[u8] = &[0xef, 0xbb, 0xbf];
    if let Some(rest) = bytes.strip_prefix(BOM) {
        if rest.starts_with(BOM) {
            return Err(YtmError::format(
                "KIS-NET response contains more than one UTF-8 BOM.",
            ));
        }
        Ok(rest)
    } else {
        Ok(bytes)
    }
}

fn record_selected_error(slot: &mut Option<YtmError>, reason: impl Into<String>) {
    slot.get_or_insert_with(|| YtmError::format(reason));
}

fn validate_xml_characters(value: &str) -> Result<(), YtmError> {
    if value.chars().all(|character| {
        matches!(character as u32, 0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
    }) {
        Ok(())
    } else {
        Err(YtmError::format(
            "KIS-NET response contains a character forbidden by XML 1.0.",
        ))
    }
}

fn validate_declaration(bytes: &[u8]) -> Result<(), YtmError> {
    if !bytes.starts_with(b"<?xml") {
        return Ok(());
    }
    let end = bytes
        .windows(2)
        .position(|window| window == b"?>")
        .ok_or_else(|| YtmError::format("KIS-NET XML declaration is not terminated."))?;
    let declaration = &bytes[5..end];
    let mut cursor = DeclarationCursor::new(declaration);
    if !cursor.skip_whitespace() {
        return Err(YtmError::format(
            "KIS-NET XML declaration must separate xml from version with XML whitespace.",
        ));
    }
    let version = cursor.attribute("version")?;
    if version != "1.0" {
        return Err(YtmError::format("KIS-NET response must use XML 1.0."));
    }
    cursor.skip_whitespace();
    if cursor.peek_name() == Some("encoding") {
        let encoding = cursor.attribute("encoding")?;
        if !encoding.eq_ignore_ascii_case("UTF-8") {
            return Err(YtmError::format(
                "KIS-NET response must declare UTF-8 when an encoding is present.",
            ));
        }
    }
    cursor.skip_whitespace();
    if cursor.peek_name() == Some("standalone") {
        let standalone = cursor.attribute("standalone")?;
        if !matches!(standalone.as_str(), "yes" | "no") {
            return Err(YtmError::format(
                "KIS-NET XML standalone declaration must be yes or no.",
            ));
        }
    }
    cursor.skip_whitespace();
    if !cursor.is_finished() {
        return Err(YtmError::format(
            "KIS-NET XML declaration attributes are duplicated, unknown, or out of order.",
        ));
    }
    Ok(())
}

struct DeclarationCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> DeclarationCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn skip_whitespace(&mut self) -> bool {
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.offset += 1;
        }
        self.offset != start
    }

    fn peek_name(&self) -> Option<&str> {
        let start = self.offset;
        let mut end = start;
        while self
            .bytes
            .get(end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        {
            end += 1;
        }
        std::str::from_utf8(self.bytes.get(start..end)?).ok()
    }

    fn attribute(&mut self, expected: &str) -> Result<String, YtmError> {
        if self.peek_name() != Some(expected) {
            return Err(YtmError::format(format!(
                "KIS-NET XML declaration must contain {expected} in the required order."
            )));
        }
        self.offset += expected.len();
        self.skip_whitespace();
        if self.bytes.get(self.offset) != Some(&b'=') {
            return Err(YtmError::format(
                "KIS-NET XML declaration contains an invalid attribute.",
            ));
        }
        self.offset += 1;
        self.skip_whitespace();
        let quote = *self.bytes.get(self.offset).ok_or_else(|| {
            YtmError::format("KIS-NET XML declaration contains an incomplete attribute.")
        })?;
        if !matches!(quote, b'\'' | b'"') {
            return Err(YtmError::format(
                "KIS-NET XML declaration attribute values must be quoted.",
            ));
        }
        self.offset += 1;
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| *byte != quote)
        {
            if !self.bytes[self.offset].is_ascii() {
                return Err(YtmError::format(
                    "KIS-NET XML declaration contains non-XML characters.",
                ));
            }
            self.offset += 1;
        }
        let value = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| YtmError::format("KIS-NET XML declaration is not ASCII."))?
            .to_owned();
        if self.bytes.get(self.offset) != Some(&quote) {
            return Err(YtmError::format(
                "KIS-NET XML declaration contains an unterminated attribute.",
            ));
        }
        self.offset += 1;
        Ok(value)
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn is_status_integer(value: &str) -> bool {
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn resolve_reference(reference: &str) -> Result<String, YtmError> {
    let predefined = match reference {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "apos" => Some("'"),
        "quot" => Some("\""),
        _ => None,
    };
    if let Some(value) = predefined {
        return Ok(value.to_owned());
    }
    let number = if let Some(hex) = reference.strip_prefix("#x") {
        u32::from_str_radix(hex, 16).ok()
    } else if let Some(decimal) = reference.strip_prefix('#') {
        decimal.parse::<u32>().ok()
    } else {
        None
    };
    let character = number.and_then(char::from_u32).filter(|character| {
        matches!(*character as u32, 0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
    });
    character.map(|value| value.to_string()).ok_or_else(|| {
        YtmError::format("KIS-NET response contains an invalid or unsupported entity reference.")
    })
}

fn is_zero_status(value: &str) -> bool {
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte == b'0')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn parses_init_fixture() {
        let bytes = include_bytes!("../../../contracts/kisnet/init-success.xml");
        let response = parse(bytes, "output1").unwrap();
        assert_eq!(response.rows.len(), 7);
        assert_eq!(response.rows[0]["divName"], "국채");
    }

    #[test]
    fn accepts_every_valid_xml_evidence_case() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../contracts/kisnet/cases.json")).unwrap();
        for case in cases["xmlCases"]["valid"].as_array().unwrap() {
            let fixture_key = case["fixture"].as_str().unwrap();
            let filename = cases["fixtures"][fixture_key].as_str().unwrap();
            let bytes = std::fs::read(contract_fixture(filename)).unwrap();
            parse(&bytes, "output1")
                .unwrap_or_else(|error| panic!("valid fixture {filename} failed: {error}"));
        }
    }

    #[test]
    fn rejects_every_invalid_xml_evidence_case() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../contracts/kisnet/cases.json")).unwrap();
        for fixture_key in cases["xmlCases"]["invalid"].as_array().unwrap() {
            let fixture_key = fixture_key.as_str().unwrap();
            let filename = cases["fixtures"][fixture_key].as_str().unwrap();
            let bytes = std::fs::read(contract_fixture(filename)).unwrap();
            let error = match parse(&bytes, "output1") {
                Ok(_) => panic!("invalid fixture {filename} was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.details.code, "source_format_error", "{filename}");
        }
    }

    #[test]
    fn enforces_body_bom_utf8_and_depth_boundaries() {
        let fixture = include_bytes!("../../../contracts/kisnet/init-success.xml");
        let mut exact = fixture.to_vec();
        exact.extend_from_slice(b"<!--");
        exact.extend(std::iter::repeat_n(
            b'x',
            MAX_RESPONSE_BODY_BYTES - fixture.len() - 7,
        ));
        exact.extend_from_slice(b"-->");
        assert_eq!(exact.len(), MAX_RESPONSE_BODY_BYTES);
        assert!(parse(&exact, "output1").is_ok());
        exact.push(b' ');
        assert_eq!(
            parse(&exact, "output1").unwrap_err().details.code,
            "source_format_error"
        );

        let mut single_bom = vec![0xef, 0xbb, 0xbf];
        single_bom.extend_from_slice(fixture);
        assert!(parse(&single_bom, "output1").is_ok());
        let mut double_bom = vec![0xef, 0xbb, 0xbf];
        double_bom.extend_from_slice(&single_bom);
        assert!(parse(&double_bom, "output1").is_err());
        let mut invalid_utf8 = fixture.to_vec();
        invalid_utf8.push(0xff);
        assert!(parse(&invalid_utf8, "output1").is_err());

        assert!(parse(&depth_fixture(MAX_ELEMENT_DEPTH), "output1").is_ok());
        assert!(parse(&depth_fixture(MAX_ELEMENT_DEPTH + 1), "output1").is_err());
    }

    #[test]
    fn reports_protocol_status_before_selected_dataset_absence() {
        let error = parse(
            include_bytes!("../../../contracts/kisnet/protocol-error.xml"),
            "output1",
        )
        .unwrap_err();
        assert_eq!(error.details.code, "source_protocol_error");
        assert_eq!(error.details.source_error_code.as_deref(), Some("-1"));
    }

    #[test]
    fn reports_protocol_status_before_selected_dataset_structure() {
        let error = parse(&response_with_status("-7", "<Unexpected/>"), "output1").unwrap_err();
        assert_eq!(error.details.code, "source_protocol_error");
        assert_eq!(error.details.source_error_code.as_deref(), Some("-7"));

        let error = parse(&response_with_status("0", "<Unexpected/>"), "output1").unwrap_err();
        assert_eq!(error.details.code, "source_format_error");
    }

    #[test]
    fn ignores_open_content_inside_unrelated_datasets() {
        let xml = format!(
            "<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"unrelated\"><Vendor><Value>open content</Value></Vendor></Dataset><Dataset id=\"output1\"><Rows/></Dataset></Root>",
            namespace = std::str::from_utf8(NAMESPACE).unwrap(),
        );
        assert!(parse(xml.as_bytes(), "output1").is_ok());
    }

    #[test]
    fn rejects_declarations_after_any_document_content() {
        let fixture = include_bytes!("../../../contracts/kisnet/init-success.xml");
        for prefix in [b" \n".as_slice(), b"<!--before-->".as_slice()] {
            let mut xml = prefix.to_vec();
            xml.extend_from_slice(fixture);
            assert_eq!(
                parse(&xml, "output1").unwrap_err().details.code,
                "source_format_error"
            );
        }
    }

    #[test]
    fn requires_an_unqualified_id_attribute() {
        let xml = format!(
            "<Root xmlns=\"{namespace}\" xmlns:vendor=\"urn:vendor\"><Parameters><Parameter vendor:id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>",
            namespace = std::str::from_utf8(NAMESPACE).unwrap(),
        );
        assert_eq!(
            parse(xml.as_bytes(), "output1").unwrap_err().details.code,
            "source_format_error"
        );
    }

    #[test]
    fn validates_attributes_even_when_the_profile_ignores_them() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        for xml in [
            format!("<Root xmlns=\"{namespace}\" vendor=\"&bogus;\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" vendor=\"a\" vendor=\"b\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" vendor:x=\"a\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" xmlns:a=\"urn:vendor\" xmlns:b=\"urn:vendor\" a:x=\"a\" b:x=\"b\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" xmlns:a=\"urn:x&amp;y\" xmlns:b=\"urn:x&#38;y\" a:z=\"a\" b:z=\"b\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" 1bad=\"x\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\" vendor=\"<\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
        ] {
            let error = parse(xml.as_bytes(), "output1").unwrap_err();
            assert_eq!(error.details.code, "source_format_error");
            assert_eq!(
                error.details.reason,
                "KIS-NET response contains invalid XML attributes."
            );
        }
    }

    #[test]
    fn normalizes_namespace_references_before_profile_matching() {
        let xml = "<Root xmlns=\"http://www.nexacroplatform.com/platform/data&#115;et\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>";
        assert!(parse(xml.as_bytes(), "output1").is_ok());
    }

    #[test]
    fn normalizes_xml_1_0_line_endings_in_text_and_cdata() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        let xml = format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows><Row><Col id=\"text\">A\r\nB\rC</Col><Col id=\"cdata\"><![CDATA[D\r\nE\rF]]></Col></Row></Rows></Dataset></Root>");
        let response = parse(xml.as_bytes(), "output1").unwrap();
        assert_eq!(response.rows[0]["text"], "A\nB\nC");
        assert_eq!(response.rows[0]["cdata"], "D\nE\nF");
    }

    #[test]
    fn accepts_unicode_xml_names() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        let xml = format!("<Root xmlns=\"{namespace}\" 한글=\"ok\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"unrelated\"><확장/></Dataset><Dataset id=\"output1\"><Rows/></Dataset></Root>");
        assert!(parse(xml.as_bytes(), "output1").is_ok());
    }

    #[test]
    fn maps_parser_diagnostics_to_project_owned_errors() {
        let error = parse(
            include_bytes!("../../../contracts/kisnet/xml-invalid-malformed-nesting.xml"),
            "output1",
        )
        .unwrap_err();
        assert_eq!(
            error.details.reason,
            "KIS-NET response contains malformed Nexacro XML."
        );
        assert!(!error.details.reason.contains("Unexpected"));
    }

    #[test]
    fn keeps_source_identifiers_out_of_public_errors() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        let invalid_child = format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><VendorSecret/></Dataset></Root>");
        let error = parse(invalid_child.as_bytes(), "output1").unwrap_err();
        assert_eq!(
            error.details.reason,
            "KIS-NET selected Dataset has an invalid direct child."
        );

        let duplicate_column = format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows><Row><Col id=\"SensitiveVendorColumn\">a</Col><Col id=\"SensitiveVendorColumn\">b</Col></Row></Rows></Dataset></Root>");
        let error = parse(duplicate_column.as_bytes(), "output1").unwrap_err();
        assert_eq!(
            error.details.reason,
            "KIS-NET row contains a duplicate column."
        );
    }

    #[test]
    fn rejects_raw_characters_forbidden_by_xml_1_0_everywhere() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        let invalid = '\u{1}';
        for xml in [
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows><Row><Col id=\"divCode\">10{invalid}</Col></Row></Rows></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows><Row><Col id=\"divCode\"><![CDATA[10{invalid}]]></Col></Row></Rows></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode{invalid}\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\"><!--{invalid}--><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"unrelated\"><Vendor>{invalid}</Vendor></Dataset><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
        ] {
            let error = parse(xml.as_bytes(), "output1").unwrap_err();
            assert_eq!(error.details.code, "source_format_error");
            assert!(error.details.reason.contains("forbidden by XML 1.0"));
        }
    }

    #[test]
    fn preserves_identifier_text_for_protocol_matching() {
        let namespace = std::str::from_utf8(NAMESPACE).unwrap();
        for xml in [
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode \">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>"),
            format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1 \"><Rows/></Dataset></Root>"),
        ] {
            assert_eq!(
                parse(xml.as_bytes(), "output1").unwrap_err().details.code,
                "source_format_error"
            );
        }

        let xml = format!("<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows><Row><Col id=\"m3 \">2.5</Col></Row></Rows></Dataset></Root>");
        let response = parse(xml.as_bytes(), "output1").unwrap();
        assert!(response.rows[0].contains_key("m3 "));
        assert!(!response.rows[0].contains_key("m3"));
    }

    fn contract_fixture(filename: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../contracts/kisnet")
            .join(filename)
    }

    fn depth_fixture(depth: usize) -> Vec<u8> {
        let nested = "<Extra>".repeat(depth.saturating_sub(2));
        let closing = "</Extra>".repeat(depth.saturating_sub(2));
        format!(
            "<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"unrelated\">{nested}{closing}</Dataset><Dataset id=\"output1\"><Rows/></Dataset></Root>",
            namespace = std::str::from_utf8(NAMESPACE).unwrap(),
        )
        .into_bytes()
    }

    fn response_with_status(status: &str, selected_content: &str) -> Vec<u8> {
        format!(
            "<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">{status}</Parameter></Parameters><Dataset id=\"output1\">{selected_content}</Dataset></Root>",
            namespace = std::str::from_utf8(NAMESPACE).unwrap(),
        )
        .into_bytes()
    }
}
