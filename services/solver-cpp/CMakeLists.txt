cmake_minimum_required(VERSION 3.20)
project(ChronosSolverCpp VERSION 0.2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Threading & PkgConfig dependencies
find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)

option(BUILD_TESTING "Build GoogleTest unit and sanitizer test suites" ON)

pkg_check_modules(GRPC REQUIRED IMPORTED_TARGET grpc++ grpc protobuf)
pkg_check_modules(ONNXRUNTIME QUIET IMPORTED_TARGET libonnxruntime)
if(NOT ONNXRUNTIME_FOUND)
    find_path(ONNXRUNTIME_INCLUDE_DIR onnxruntime_cxx_api.h
        PATH_SUFFIXES onnxruntime onnxruntime/core/session
    )
    find_library(ONNXRUNTIME_LIBRARY onnxruntime)
    if(ONNXRUNTIME_INCLUDE_DIR AND ONNXRUNTIME_LIBRARY)
        add_library(PkgConfig::ONNXRUNTIME INTERFACE IMPORTED)
        target_include_directories(PkgConfig::ONNXRUNTIME SYSTEM INTERFACE "${ONNXRUNTIME_INCLUDE_DIR}")
        target_link_libraries(PkgConfig::ONNXRUNTIME INTERFACE "${ONNXRUNTIME_LIBRARY}")
    else()
        message(FATAL_ERROR "libonnxruntime headers and library not found")
    endif()
endif()

if(BUILD_TESTING)
    pkg_check_modules(GTEST REQUIRED IMPORTED_TARGET gtest_main gtest)
endif()

# Ensure Protobuf + gRPC C++ stubs exist in src/proto/
set(PROTO_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/src/proto")
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../../proto/routing_service.proto")
    set(PROTO_FILE "${CMAKE_CURRENT_SOURCE_DIR}/../../proto/routing_service.proto")
    set(PROTO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../proto")
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/proto/routing_service.proto")
    set(PROTO_FILE "${CMAKE_CURRENT_SOURCE_DIR}/proto/routing_service.proto")
    set(PROTO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/proto")
endif()

file(MAKE_DIRECTORY "${PROTO_SRC_DIR}")
if(DEFINED PROTO_FILE AND EXISTS "${PROTO_FILE}")
    find_program(PROTOC_EXECUTABLE protoc REQUIRED)
    find_program(GRPC_CPP_PLUGIN grpc_cpp_plugin REQUIRED)
    execute_process(
        COMMAND "${PROTOC_EXECUTABLE}"
            "-I${PROTO_DIR}"
            "--cpp_out=${PROTO_SRC_DIR}"
            "--grpc_out=${PROTO_SRC_DIR}"
            "--plugin=protoc-gen-grpc=${GRPC_CPP_PLUGIN}"
            "${PROTO_FILE}"
        RESULT_VARIABLE PROTOC_RESULT
    )
    if(NOT PROTOC_RESULT EQUAL 0)
        message(FATAL_ERROR "protoc failed to generate C++ gRPC stubs")
    endif()
endif()

# 1. Generated Protobuf/gRPC library (suppress warnings and match system libprotobuf NDEBUG ABI)
add_library(chronos_proto STATIC
    "${PROTO_SRC_DIR}/routing_service.pb.cc"
    "${PROTO_SRC_DIR}/routing_service.grpc.pb.cc"
)
target_compile_options(chronos_proto PRIVATE -w -DNDEBUG -fno-sanitize=all)
target_compile_definitions(chronos_proto PUBLIC NDEBUG)
target_include_directories(chronos_proto SYSTEM PUBLIC "${PROTO_SRC_DIR}")
target_link_libraries(chronos_proto PUBLIC PkgConfig::GRPC Threads::Threads)

# 2. Core Solver Engine library with strict warning flags
set(CHRONOS_STRICT_WARNINGS
    -Wall
    -Wextra
    -Wpedantic
    -Wconversion
    -Wshadow
    -Wnon-virtual-dtor
)

add_library(chronos_solver_core STATIC
    src/csr_graph.cpp
    src/thread_pool.cpp
    src/shortest_path.cpp
    src/onnx_scorer.cpp
    src/alns_solver.cpp
    src/grpc_server.cpp
)

target_include_directories(chronos_solver_core
    PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_compile_options(chronos_solver_core PRIVATE ${CHRONOS_STRICT_WARNINGS})

target_link_libraries(chronos_solver_core
    PUBLIC
    chronos_proto
    PkgConfig::GRPC
    PkgConfig::ONNXRUNTIME
    Threads::Threads
)

# 3. Solver gRPC server executable
add_executable(solver_node
    src/main.cpp
)
target_compile_options(solver_node PRIVATE ${CHRONOS_STRICT_WARNINGS})
target_link_libraries(solver_node PRIVATE chronos_solver_core)

# 4. Testing support
if(BUILD_TESTING)
    enable_testing()
    add_subdirectory(tests)
endif()
