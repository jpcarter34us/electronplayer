{
  "variables": {
    # Development: the engine in vendor/prefix. Packaging passes the staged
    # engine instead (scripts/build-engine-bundle.sh).
    "audcore_include%": "<(module_root_dir)/../vendor/prefix/include",
    "audcore_lib%": "<(module_root_dir)/../vendor/prefix/lib"
  },
  "targets": [{
    "target_name": "audcore",
    "sources": ["src/addon.cc"],
    "include_dirs": [
      "<!(node -p \"require('node-addon-api').include_dir\")",
      "<(audcore_include)"
    ],
    "libraries": ["-L<(audcore_lib)", "-laudcore"],
    # Electron's common.gypi asks for C++20, which GCC 9 (the Linux build's
    # Ubuntu 20.04) lacks; the addon uses only Node-API, which needs C++17.
    "cflags_cc!": ["-std=gnu++20", "-std=c++20"],
    "cflags_cc": ["-std=c++17"],
    "defines": ["NAPI_VERSION=9", "NAPI_DISABLE_CPP_EXCEPTIONS"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "MACOSX_DEPLOYMENT_TARGET": "12.0",
      "OTHER_LDFLAGS": ["-Wl,-rpath,<(audcore_lib)", "-Wl,-headerpad_max_install_names"]
    }
  }]
}
