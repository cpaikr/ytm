use crate::transport::PreparedRequest;
use quick_xml::escape::escape;

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
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Root xmlns="http://www.nexacroplatform.com/platform/dataset">
  <Parameters/>
  <Dataset id="ds_search">
    <ColumnInfo>
      <Column id="pageIndex" type="STRING" size="256"/>
      <Column id="pageSize" type="STRING" size="256"/>
      <Column id="pageUnit" type="STRING" size="256"/>
      <Column id="calBaseDt" type="STRING" size="256"/>
      <Column id="cboYtmSort" type="STRING" size="256"/>
    </ColumnInfo>
    <Rows><Row>
      <Col id="pageIndex">1</Col>
      <Col id="pageSize">10</Col>
      <Col id="pageUnit">10</Col>
      <Col id="calBaseDt">{base_date}</Col>
      <Col id="cboYtmSort">{kind}</Col>
    </Row></Rows>
  </Dataset>
  <Dataset id="gds_tranInfo">
    <ColumnInfo>
      <Column id="svcID" type="STRING" size="32"/>
      <Column id="URL" type="STRING" size="32"/>
      <Column id="inDatasets" type="STRING" size="32"/>
      <Column id="outDatasets" type="STRING" size="32"/>
      <Column id="browserType" type="STRING" size="32"/>
    </ColumnInfo>
    <Rows><Row>
      <Col id="svcID">{service_id}</Col>
      <Col id="URL">{path}</Col>
      <Col id="inDatasets">{in_datasets}</Col>
      <Col id="outDatasets">{out_datasets}</Col>
      <Col id="browserType">Chrome</Col>
    </Row></Rows>
  </Dataset>
</Root>"#,
        base_date = escape(base_date_compact),
        kind = escape(kind_code),
        service_id = escape(service_id),
        path = escape(path),
        in_datasets = escape(IN_DATASETS),
        out_datasets = escape(out_datasets),
    );
    PreparedRequest {
        operation,
        path,
        url: format!("{SOURCE_ORIGIN}{path}"),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml_ng::Value;

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
            serde_yaml_ng::from_str(include_str!("../../../contracts/kisnet/openapi.yaml"))
                .unwrap();
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
