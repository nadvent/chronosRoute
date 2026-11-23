#include "chronos/chronos.hpp"
#include "chronos/grpc_server.hpp"

#include <grpcpp/grpcpp.h>

#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <string_view>

namespace {

bool parse_strict_double(const char* raw, double& out_value) {
    if (raw == nullptr || *raw == '\0') {
        return false;
    }

    errno = 0;
    char* end_ptr = nullptr;
    const double parsed = std::strtod(raw, &end_ptr);
    if (end_ptr == raw) {
        return false;
    }
    while (*end_ptr != '\0' && std::isspace(static_cast<unsigned char>(*end_ptr))) {
        ++end_ptr;
    }
    if (*end_ptr != '\0' || errno == ERANGE || !std::isfinite(parsed)) {
        return false;
    }

    out_value = parsed;
    return true;
}

} // namespace

int main(int argc, char* argv[]) {
    int port = chronos::kDefaultPort;
    bool dry_run = false;

    for (int i = 1; i < argc; ++i) {
        const std::string_view arg(argv[i]);
        if (arg == "--dry-run" || arg == "--version") {
            dry_run = true;
        } else if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        }
    }

    const char* raw_json = std::getenv("CHRONOS_ROAD_GRAPH_JSON");
    const char* raw_lat = std::getenv("CHRONOS_GRID_ORIGIN_LAT");
    const char* raw_lon = std::getenv("CHRONOS_GRID_ORIGIN_LON");
    const bool lat_set = (raw_lat != nullptr && *raw_lat != '\0');
    const bool lon_set = (raw_lon != nullptr && *raw_lon != '\0');

    std::unique_ptr<chronos::RoutingServiceImpl> service;
    double origin_lat = 51.5074;
    double origin_lon = -0.1278;
    std::string graph_label = "curved-urban-default";

    if (raw_json != nullptr && *raw_json != '\0') {
        auto osm_graph = chronos::CsrGraph::load_from_json_file(raw_json);
        if (osm_graph) {
            service = std::make_unique<chronos::RoutingServiceImpl>(std::move(osm_graph));
            graph_label = std::string("osm-json:") + raw_json;
        } else {
            std::cerr << "[ChronosRoute] Failed to load CHRONOS_ROAD_GRAPH_JSON (" << raw_json
                      << "); falling back to curved urban network.\n";
        }
    }

    if (!service) {
        if (lat_set && lon_set) {
            if (parse_strict_double(raw_lat, origin_lat) &&
                parse_strict_double(raw_lon, origin_lon) &&
                origin_lat >= -90.0 && origin_lat <= 90.0 &&
                origin_lon >= -180.0 && origin_lon <= 180.0) {
                graph_label = "curved-urban-centered";
            } else {
                origin_lat = 51.5074;
                origin_lon = -0.1278;
                std::cerr << "[ChronosRoute] Invalid CHRONOS_GRID_ORIGIN_LAT/LON; "
                          << "using London curved urban road network.\n";
            }
        } else if (lat_set || lon_set) {
            std::cerr << "[ChronosRoute] Both CHRONOS_GRID_ORIGIN_LAT and CHRONOS_GRID_ORIGIN_LON "
                      << "must be provided; using London curved urban road network.\n";
        }

        auto graph = chronos::CsrGraph::create_curved_urban_network(
            origin_lat, origin_lon, 4U, 12U, 4800.0);
        service = std::make_unique<chronos::RoutingServiceImpl>(std::move(graph));
    }

    std::cout << "[ChronosRoute] Solver Engine Node v" << chronos::kEngineVersion
              << " initialized (" << service->graph()->num_nodes() << " nodes, "
              << service->graph()->num_edges() << " edges, topology=" << graph_label
              << ", center=" << origin_lat << "," << origin_lon << ").\n";

    if (dry_run) {
        return 0;
    }

    const std::string server_address = "0.0.0.0:" + std::to_string(port);
    grpc::ServerBuilder builder;
    builder.AddListeningPort(server_address, grpc::InsecureServerCredentials());
    builder.RegisterService(service.get());

    std::unique_ptr<grpc::Server> server(builder.BuildAndStart());
    if (!server) {
        std::cerr << "[ChronosRoute] Failed to bind gRPC server on " << server_address << "\n";
        return 1;
    }

    std::cout << "[ChronosRoute] Listening for gRPC RPC requests on " << server_address << ".\n";
    server->Wait();
    return 0;
}
