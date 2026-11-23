function(add_chronos_test TEST_NAME TARGET_NAME SOURCE_FILE)
    add_executable(${TARGET_NAME} ${SOURCE_FILE})
    target_compile_options(${TARGET_NAME} PRIVATE ${CHRONOS_STRICT_WARNINGS})
    target_link_libraries(${TARGET_NAME}
        PRIVATE
        chronos_solver_core
        PkgConfig::GTEST
        Threads::Threads
    )
    add_test(NAME ${TEST_NAME} COMMAND ${TARGET_NAME})
endfunction()

add_chronos_test(SmokeTest test_smoke test_smoke.cpp)
add_chronos_test(GraphSnapshot test_graph_snapshot test_graph_snapshot.cpp)
add_chronos_test(ThreadPool test_thread_pool test_thread_pool.cpp)
add_chronos_test(ShortestPath test_shortest_path test_shortest_path.cpp)
add_chronos_test(ParallelALNS test_parallel_alns test_parallel_alns.cpp)
