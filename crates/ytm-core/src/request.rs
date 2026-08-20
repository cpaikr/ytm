use crate::transport::PreparedRequest;

pub const SOURCE_ORIGIN: &str = "https://kis-net.kr";
pub const SOURCE_PAGE_URL: &str = "https://kis-net.kr/kisnet_mobile/index.html";
pub const INIT_PATH: &str = "/rateInfo/ytmMatrixMobileInitList.do";
pub const MATRIX_PATH: &str = "/rateInfo/ytmMatrixMobileList.do";
pub const IN_DATASETS: &str = "ds_search=ds_search gds_tranInfo=gds_tranInfo";

pub fn init(base_date_compact: &str) -> PreparedRequest {
    prepare(
        "initializeYtmMatrix",
        "search",
        INIT_PATH,
        "ds_tymSort=output1 ds_list=output2",
        base_date_compact,
        "10",
    )
}

pub fn matrix(base_date_compact: &str, kind_code: &str) -> PreparedRequest {
    prepare(
        "listYtmMatrix",
        "search1",
        MATRIX_PATH,
        "ds_list=output1",
        base_date_compact,
        kind_code,
    )
}

fn prepare(
    operation: &'static str,
    service_id: &str,
    path: &'static str,
    out_datasets: &str,
    base_date_compact: &str,
    kind_code: &str,
) -> PreparedRequest {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Root xmlns=\"http://www.nexacroplatform.com/platform/dataset\">\n  <Parameters/>\n  <Dataset id=\"ds_search\">\n    <ColumnInfo>\n      <Column id=\"pageIndex\" type=\"STRING\" size=\"256\"/>\n      <Column id=\"pageSize\" type=\"STRING\" size=\"256\"/>\n      <Column id=\"pageUnit\" type=\"STRING\" size=\"256\"/>\n      <Column id=\"calBaseDt\" type=\"STRING\" size=\"256\"/>\n      <Column id=\"cboYtmSort\" type=\"STRING\" size=\"256\"/>\n    </ColumnInfo>\n    <Rows><Row>\n      <Col id=\"pageIndex\">1</Col>\n      <Col id=\"pageSize\">10</Col>\n      <Col id=\"pageUnit\">10</Col>\n      <Col id=\"calBaseDt\">{}</Col>\n      <Col id=\"cboYtmSort\">{}</Col>\n    </Row></Rows>\n  </Dataset>\n  <Dataset id=\"gds_tranInfo\">\n    <ColumnInfo>\n      <Column id=\"svcID\" type=\"STRING\" size=\"32\"/>\n      <Column id=\"URL\" type=\"STRING\" size=\"32\"/>\n      <Column id=\"inDatasets\" type=\"STRING\" size=\"32\"/>\n      <Column id=\"outDatasets\" type=\"STRING\" size=\"32\"/>\n      <Column id=\"browserType\" type=\"STRING\" size=\"32\"/>\n    </ColumnInfo>\n    <Rows><Row>\n      <Col id=\"svcID\">{}</Col>\n      <Col id=\"URL\">{}</Col>\n      <Col id=\"inDatasets\">{}</Col>\n      <Col id=\"outDatasets\">{}</Col>\n      <Col id=\"browserType\">Chrome</Col>\n    </Row></Rows>\n  </Dataset>\n</Root>",
        escape_xml(base_date_compact),
        escape_xml(kind_code),
        escape_xml(service_id),
        escape_xml(path),
        escape_xml(IN_DATASETS),
        escape_xml(out_datasets),
    );
    PreparedRequest {
        operation,
        path,
        url: format!("{SOURCE_ORIGIN}{path}"),
        body,
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;

    #[test]
    fn matrix_request_contains_both_ordered_datasets() {
        let request = matrix("20260608", "80");
        assert!(
            request.body.find("ds_search").unwrap() < request.body.find("gds_tranInfo").unwrap()
        );
        assert!(request.body.contains("<Col id=\"cboYtmSort\">80</Col>"));
        assert!(request.body.contains(MATRIX_PATH));
    }

    #[test]
    fn prepared_requests_conform_to_openapi_authority() {
        let contract: Value =
            serde_yaml::from_str(include_str!("../../../contracts/kisnet/openapi.yaml")).unwrap();
        assert_eq!(contract["servers"][0]["url"].as_str(), Some(SOURCE_ORIGIN));
        assert_eq!(
            contract["x-ytm-nexacro-profile"]["response"]["maxDecompressedBodyBytes"].as_u64(),
            Some(crate::MAX_RESPONSE_BODY_BYTES as u64)
        );
        assert_eq!(
            contract["x-ytm-nexacro-profile"]["response"]["maxElementDepth"].as_u64(),
            Some(crate::MAX_ELEMENT_DEPTH as u64)
        );
        assert_eq!(
            contract["x-ytm-nexacro-profile"]["transport"]["requestDeadlineMilliseconds"].as_u64(),
            Some(crate::REQUEST_DEADLINE_SECONDS * 1_000)
        );

        assert_operation(
            &contract,
            INIT_PATH,
            "search",
            "ds_tymSort=output1 ds_list=output2",
            init("20260608"),
        );
        assert_operation(
            &contract,
            MATRIX_PATH,
            "search1",
            "ds_list=output1",
            matrix("20260608", "80"),
        );
    }

    fn assert_operation(
        contract: &Value,
        path: &str,
        service_id: &str,
        out_datasets: &str,
        request: PreparedRequest,
    ) {
        let operation = &contract["paths"][path]["post"]["x-ytm-nexacro-request"];
        assert_eq!(operation["endpoint"].as_str(), Some(path));
        assert_eq!(operation["serviceId"].as_str(), Some(service_id));
        assert_eq!(operation["inDatasets"].as_str(), Some(IN_DATASETS));
        assert_eq!(operation["outDatasets"].as_str(), Some(out_datasets));
        assert_eq!(request.path, path);
        assert_eq!(request.url, format!("{SOURCE_ORIGIN}{path}"));
        assert!(request
            .body
            .contains(&format!("<Col id=\"svcID\">{service_id}</Col>")));
        assert!(request
            .body
            .contains(&format!("<Col id=\"outDatasets\">{out_datasets}</Col>")));
        assert!(
            request.body.find("<Dataset id=\"ds_search\">").unwrap()
                < request.body.find("<Dataset id=\"gds_tranInfo\">").unwrap()
        );
    }
}
