package org.junit.jupiter.api;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class TestRunner {
    private TestRunner() {}

    public static void main(String[] args) throws Exception {
        String groupsProp = System.getProperty("groups", "");
        String itTestProp = System.getProperty("it.test", "");
        Set<String> requiredGroups = new HashSet<>();
        if (!groupsProp.isBlank()) {
            for (String g : groupsProp.split(",")) {
                if (!g.isBlank()) {
                    requiredGroups.add(g.trim());
                }
            }
        }

        int totalTests = 0;
        int passedTests = 0;
        int skippedTests = 0;
        List<String> failures = new ArrayList<>();

        for (String className : args) {
            if (!itTestProp.isBlank() && !className.endsWith("." + itTestProp) && !className.equals(itTestProp)) {
                continue;
            }
            Class<?> testClass = Class.forName(className);
            if (testClass.isAnnotationPresent(Disabled.class)) {
                skippedTests++;
                continue;
            }

            Set<String> classTags = extractTags(testClass.getAnnotationsByType(Tag.class));

            List<Method> beforeEachMethods = new ArrayList<>();
            List<Method> afterEachMethods = new ArrayList<>();
            List<Method> testMethods = new ArrayList<>();

            for (Method m : testClass.getDeclaredMethods()) {
                if (m.isAnnotationPresent(BeforeEach.class)) {
                    m.setAccessible(true);
                    beforeEachMethods.add(m);
                }
                if (m.isAnnotationPresent(AfterEach.class)) {
                    m.setAccessible(true);
                    afterEachMethods.add(m);
                }
                if (m.isAnnotationPresent(Test.class)) {
                    m.setAccessible(true);
                    testMethods.add(m);
                }
            }

            testMethods.sort((a, b) -> a.getName().compareTo(b.getName()));

            int classTotal = 0;
            int classFailures = 0;
            int classSkipped = 0;

            for (Method testMethod : testMethods) {
                Set<String> effectiveTags = new HashSet<>(classTags);
                effectiveTags.addAll(extractTags(testMethod.getAnnotationsByType(Tag.class)));

                if (!requiredGroups.isEmpty()) {
                    boolean matchesGroup = false;
                    for (String req : requiredGroups) {
                        if (effectiveTags.contains(req)) {
                            matchesGroup = true;
                            break;
                        }
                    }
                    if (!matchesGroup) {
                        continue;
                    }
                }

                if (testMethod.isAnnotationPresent(Disabled.class)) {
                    skippedTests++;
                    classSkipped++;
                    continue;
                }

                totalTests++;
                classTotal++;
                var ctor = testClass.getDeclaredConstructor();
                ctor.setAccessible(true);
                Object instance = ctor.newInstance();

                try {
                    for (Method before : beforeEachMethods) {
                        before.invoke(instance);
                    }
                    testMethod.invoke(instance);
                    passedTests++;
                    System.out.println("  [PASS] " + testClass.getSimpleName() + "#" + testMethod.getName());
                } catch (InvocationTargetException ite) {
                    Throwable cause = ite.getTargetException();
                    classFailures++;
                    String failureMsg = testClass.getName() + "#" + testMethod.getName() + ": " + cause;
                    failures.add(failureMsg);
                    System.err.println("  [FAIL] " + failureMsg);
                    cause.printStackTrace(System.err);
                } finally {
                    for (Method after : afterEachMethods) {
                        try {
                            after.invoke(instance);
                        } catch (Exception ignored) {
                        }
                    }
                }
            }

            if (classTotal > 0 || classSkipped > 0) {
                System.out.printf(
                        "[INFO] Tests run: %d, Failures: %d, Skipped: %d - in %s%n",
                        classTotal, classFailures, classSkipped, testClass.getName());
            }
        }

        System.out.printf(
                "%n[INFO] Results: Tests run: %d, Passed: %d, Failures: %d, Skipped: %d%n",
                totalTests, passedTests, failures.size(), skippedTests);

        if (!failures.isEmpty()) {
            System.exit(1);
        }
    }

    private static Set<String> extractTags(Tag[] tags) {
        Set<String> result = new HashSet<>();
        if (tags != null) {
            Arrays.stream(tags).forEach(t -> result.add(t.value()));
        }
        return result;
    }
}
