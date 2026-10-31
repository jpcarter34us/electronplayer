# Build environments for the Linux and Windows engines and packages, used by
# scripts/package-other.sh. Debian 12 (glibc 2.36) so the Linux builds run on
# any distribution from about 2022 on.
#
#   linux-x64    native compilers and amd64 libraries
#   linux-arm64  cross compilers and arm64 libraries (Debian multiarch)
#   windows      llvm-mingw for x64 and arm64 (libraries come from MSYS2,
#                fetched by scripts/fetch-msys2-deps.py), Wine for
#                electron-builder and tests; also packages every Linux and
#                Windows build
FROM debian:bookworm AS base
ARG NODE_VERSION=22.23.3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential meson ninja-build pkg-config gettext git python3 curl ca-certificates \
      xz-utils zstd file patchelf binutils nasm \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1

# Libraries the plugins use, for one Debian architecture (":amd64"/":arm64").
# FFmpeg is not here: Debian's links half the multimedia stack, so a small
# audio-only FFmpeg is built from source instead (scripts/build-engine-other.sh).
FROM base AS linux-libs
ARG DEB_ARCH
RUN dpkg --add-architecture ${DEB_ARCH} && apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-dev:${DEB_ARCH} libflac-dev:${DEB_ARCH} libvorbis-dev:${DEB_ARCH} libogg-dev:${DEB_ARCH} \
      libopus-dev:${DEB_ARCH} libopusfile-dev:${DEB_ARCH} libmpg123-dev:${DEB_ARCH} libsndfile1-dev:${DEB_ARCH} \
      libwavpack-dev:${DEB_ARCH} libopenmpt-dev:${DEB_ARCH} libmodplug-dev:${DEB_ARCH} libsidplayfp-dev:${DEB_ARCH} \
      libfluidsynth-dev:${DEB_ARCH} libfaad-dev:${DEB_ARCH} libcue-dev:${DEB_ARCH} libneon27-gnutls-dev:${DEB_ARCH} \
      libsoxr-dev:${DEB_ARCH} libsamplerate0-dev:${DEB_ARCH} libbs2b-dev:${DEB_ARCH} libmp3lame-dev:${DEB_ARCH} \
      libxml2-dev:${DEB_ARCH} libcurl4-gnutls-dev:${DEB_ARCH} \
      libasound2-dev:${DEB_ARCH} libpulse-dev:${DEB_ARCH} libpipewire-0.3-dev:${DEB_ARCH} libjack-jackd2-dev:${DEB_ARCH} \
    && rm -rf /var/lib/apt/lists/*

FROM linux-libs AS linux-x64

FROM linux-libs AS linux-arm64
RUN apt-get update && apt-get install -y --no-install-recommends crossbuild-essential-arm64 qemu-user \
    && rm -rf /var/lib/apt/lists/*

FROM base AS windows
ARG LLVM_MINGW=20261020
RUN curl -fsSL "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW}/llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-x86_64.tar.xz" \
      | tar -xJ -C /opt && mv /opt/llvm-mingw-* /opt/llvm-mingw
ENV PATH=/opt/llvm-mingw/bin:$PATH
# Wine: NSIS runs its (32-bit) uninstaller stub with it while building the
# installer, and the tests run the Windows app under it.
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      wine wine64 wine32:i386 xvfb xauth fakeroot \
    && rm -rf /var/lib/apt/lists/*
