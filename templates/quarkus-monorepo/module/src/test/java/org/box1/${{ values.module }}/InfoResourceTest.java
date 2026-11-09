package org.box1.${{ values.module }};

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;
import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.is;

@QuarkusTest
class InfoResourceTest {
    @Test
    void reportsTheModuleIdentity() {
        given().when().get("/api/info").then().statusCode(200)
            .body("repository", is("${{ values.name }}"))
            .body("module", is("${{ values.module }}"));
    }

    @Test
    void isReady() {
        given().when().get("/q/health/ready").then().statusCode(200).body("status", is("UP"));
    }
}
