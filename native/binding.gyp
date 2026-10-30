{
  "targets": [{
    "target_name": "audcore",
    "sources": ["src/addon.cc"],
    "include_dirs": [
      "<!(node -p \"require('node-addon-api').include_dir\")",
      "../vendor/prefix/include"
    ],
    "libraries": ["-L<(module_root_dir)/../vendor/prefix/lib", "-laudcore"],
    "cflags_cc": ["-std=c++17"],
    "defines": ["NAPI_VERSION=9", "NAPI_DISABLE_CPP_EXCEPTIONS"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "MACOSX_DEPLOYMENT_TARGET": "12.0",
      "OTHER_LDFLAGS": ["-Wl,-rpath,@loader_path/../../../vendor/prefix/lib"]
    }
  }]
}
