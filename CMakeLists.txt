cmake_minimum_required(VERSION 3.10)
project(termchat VERSION 0.1.0)

set(BINARY_NAME termchat)
set(GO_SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR})
set(GO_BINARY ${CMAKE_CURRENT_BINARY_DIR}/${BINARY_NAME})

# Find Go
find_program(GO_EXECUTABLE go REQUIRED)

# Build target
add_custom_target(${BINARY_NAME} ALL
    COMMAND ${GO_EXECUTABLE} build -o ${GO_BINARY}
    WORKING_DIRECTORY ${GO_SOURCE_DIR}
    COMMENT "Building ${BINARY_NAME}"
)

# Install binary
install(PROGRAMS ${GO_BINARY}
    DESTINATION bin
)

# Install web assets
install(DIRECTORY public/
    DESTINATION share/${BINARY_NAME}/public
    FILES_MATCHING
    PATTERN "*.html"
    PATTERN "*.js"
    PATTERN "*.css"
)

# Clean target
add_custom_target(clean-all
    COMMAND ${CMAKE_COMMAND} -E remove ${GO_BINARY}
    COMMAND ${GO_EXECUTABLE} clean
    WORKING_DIRECTORY ${GO_SOURCE_DIR}
)

# Test target
add_custom_target(test
    COMMAND ${GO_EXECUTABLE} test -v ./...
    WORKING_DIRECTORY ${GO_SOURCE_DIR}
)

# RPM build target
add_custom_target(rpm
    COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/scripts/build-rpm.sh
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Building RPM package"
)

# ARM64 build target (Raspberry Pi / Ampere)
add_custom_target(arm64
    COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/scripts/build-arm64.sh termchat-arm64
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Building ARM64 binary (raspi/ampere)"
)

# Version info
message(STATUS "termchat version: ${PROJECT_VERSION}")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Install prefix: ${CMAKE_INSTALL_PREFIX}")
