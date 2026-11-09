package org.box1.${{ values.module }};

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ModuleInfoTest {
    @Test
    void describesThisModuleAndItsBundlePath() {
        ModuleInfo info = ModuleInfo.current();
        assertEquals("${{ values.name }}", info.repository());
        assertEquals("${{ values.module }}", info.module());
        assertEquals("/${{ values.module }}/quarkus-app/", info.bundlePath());
        assertTrue(info.javaVersion() >= 21);
    }

    @Test
    void rejectsMissingIdentityOrAnOldJava() {
        assertThrows(IllegalArgumentException.class, () -> new ModuleInfo(" ", "${{ values.module }}", 21));
        assertThrows(IllegalArgumentException.class, () -> new ModuleInfo("${{ values.name }}", null, 21));
        assertThrows(IllegalArgumentException.class, () -> new ModuleInfo("${{ values.name }}", "${{ values.module }}", 17));
    }
}
