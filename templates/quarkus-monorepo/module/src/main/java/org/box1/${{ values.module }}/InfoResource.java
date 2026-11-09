package org.box1.${{ values.module }};

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/api/info")
@Produces(MediaType.APPLICATION_JSON)
public class InfoResource {
    @GET
    public ModuleInfo info() {
        return ModuleInfo.current();
    }
}
