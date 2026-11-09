package org.box1.${{ values.module }};

/**
 * Identity of this module inside the ${{ values.name }} bundle.
 *
 * @param repository the source repository
 * @param module the module directory, also its path in the bundle
 * @param javaVersion the Java feature release running the module
 */
public record ModuleInfo(String repository, String module, int javaVersion) {
    public static final String REPOSITORY = "${{ values.name }}";
    public static final String MODULE = "${{ values.module }}";

    public ModuleInfo {
        if (repository == null || repository.isBlank() || module == null || module.isBlank()) {
            throw new IllegalArgumentException("repository and module are required");
        }
        if (javaVersion < 21) {
            throw new IllegalArgumentException("Java 21 or later is required");
        }
    }

    public static ModuleInfo current() {
        return new ModuleInfo(REPOSITORY, MODULE, Runtime.version().feature());
    }

    public String bundlePath() {
        return "/" + module + "/quarkus-app/";
    }
}
