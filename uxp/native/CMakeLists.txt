# CMake build for the Unphased UXP hybrid addon — macOS.
#
# Produces unphased.uxpaddon (a .dylib). Links FFmpeg statically so the addon is
# self-contained: no ffmpeg on PATH, which is the entire reason it exists.
#
# The source files here are the same ones the Windows .vcxproj builds
# (uxp/win/unphased.vcxproj) — one decode core, two build systems.
#
# Prereqs:
#   1. FFmpeg static libs at FFMPEG_ROOT (scripts/build-ffmpeg-mac.sh)
#   2. macOS with Xcode CLT (clang, lipo)
#
# Usage:
#   cmake -S native -B native/build \
#     -DFFMPEG_ROOT=./ffmpeg-out/universal \
#     -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/build
#   # Output: native/build/unphased.uxpaddon (universal) -> uxp/mac/{x64,arm64}/

cmake_minimum_required(VERSION 3.20)

# Both of these must be set BEFORE project(), or the compiler checks run against
# the host defaults and the settings are ignored for the real build.
#
# The FFmpeg libs from build-ffmpeg-mac.sh are lipo'd universal, but that does
# NOT make the addon universal — without this, CMake builds for the host arch
# alone, and an arm64-only .uxpaddon copied into mac/x64/ fails to load on an
# Intel Mac with nothing but a generic "addon not supported". The release
# workflow re-checks the built file with `lipo -archs`.
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "macOS architectures" FORCE)
endif()
if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version" FORCE)
endif()

project(unphased_addon_mac LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Default to exporting all symbols (the UXP macros don't annotate visibility).
set(CMAKE_C_VISIBILITY_PRESET default)
set(CMAKE_CXX_VISIBILITY_PRESET default)

set(FFMPEG_ROOT "" CACHE PATH "FFmpeg static install prefix (contains include/ and lib/)")
if(NOT FFMPEG_ROOT)
  message(FATAL_ERROR "Set -DFFMPEG_ROOT=/path/to/ffmpeg-out/universal")
endif()

set(DECODE_SRC "${CMAKE_CURRENT_SOURCE_DIR}/src")
set(UXP_SRC    "${CMAKE_CURRENT_SOURCE_DIR}/uxp/src")

add_library(unphased_uxpaddon SHARED
  ${UXP_SRC}/utilities/UxpAddon.cpp
  ${UXP_SRC}/utilities/UxpTask.cpp
  ${UXP_SRC}/utilities/UxpValue.cpp
  ${UXP_SRC}/module_unphased.cpp
  ${DECODE_SRC}/unphased_decode.cpp
)

target_include_directories(unphased_uxpaddon PRIVATE
  ${FFMPEG_ROOT}/include
  ${UXP_SRC}
  ${UXP_SRC}/api
  ${UXP_SRC}/utilities
  ${DECODE_SRC}
)

find_library(AVFORMAT    avformat    PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(AVCODEC     avcodec     PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(AVUTIL      avutil      PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)
find_library(SWRESAMPLE  swresample  PATHS ${FFMPEG_ROOT}/lib NO_DEFAULT_PATH REQUIRED)

find_library(ICONV_LIB iconv REQUIRED)
find_library(Z_LIB     z     REQUIRED)
find_library(BZ2_LIB   bz2   REQUIRED)

# FFmpeg's static libs pull in these system frameworks (they show up under
# "External libraries" in configure's output); link them all at once rather than
# playing whack-a-mole with the linker.
target_link_libraries(unphased_uxpaddon PRIVATE
  ${AVFORMAT} ${AVCODEC} ${SWRESAMPLE} ${AVUTIL}
  "-framework CoreFoundation"
  "-framework CoreVideo"
  "-framework CoreMedia"
  "-framework CoreImage"
  "-framework Security"
  "-framework AudioToolbox"
  "-framework VideoToolbox"
  "-framework Metal"
  "-framework AppKit"
  "-framework AVFoundation"
  ${ICONV_LIB} ${Z_LIB} ${BZ2_LIB}
)

set_target_properties(unphased_uxpaddon PROPERTIES
  PREFIX ""
  SUFFIX ".uxpaddon"
  OUTPUT_NAME "unphased"
  MACOSX_RPATH OFF
  INSTALL_RPATH "@loader_path"
)

# Ad-hoc code-sign so Premiere Pro's hardened runtime accepts it.
if(APPLE AND CMAKE_BUILD_TYPE STREQUAL "Release")
  add_custom_command(TARGET unphased_uxpaddon POST_BUILD
    COMMAND codesign --sign - "$<TARGET_FILE:unphased_uxpaddon>"
    COMMENT "Ad-hoc signing unphased.uxpaddon"
  )
endif()
