# WARNING: THIS FILE IS AUTOGENERATED BY update-deps.py DO NOT EDIT

load("@//build/deps:gen/dep_aspect_bazel_lib.bzl", "dep_aspect_bazel_lib")
load("@//build/deps:gen/dep_aspect_rules_esbuild.bzl", "dep_aspect_rules_esbuild")
load("@//build/deps:gen/dep_aspect_rules_js.bzl", "dep_aspect_rules_js")
load("@//build/deps:gen/dep_aspect_rules_ts.bzl", "dep_aspect_rules_ts")
load("@//build/deps:gen/dep_bazel_skylib.bzl", "dep_bazel_skylib")
load("@//build/deps:gen/dep_build_bazel_apple_support.bzl", "dep_build_bazel_apple_support")
load("@//build/deps:gen/dep_cargo_bazel_linux_arm64.bzl", "dep_cargo_bazel_linux_arm64")
load("@//build/deps:gen/dep_cargo_bazel_linux_x64.bzl", "dep_cargo_bazel_linux_x64")
load("@//build/deps:gen/dep_cargo_bazel_macos_arm64.bzl", "dep_cargo_bazel_macos_arm64")
load("@//build/deps:gen/dep_cargo_bazel_macos_x64.bzl", "dep_cargo_bazel_macos_x64")
load("@//build/deps:gen/dep_cargo_bazel_win_x64.bzl", "dep_cargo_bazel_win_x64")
load("@//build/deps:gen/dep_rules_pkg.bzl", "dep_rules_pkg")
load("@//build/deps:gen/dep_rules_python.bzl", "dep_rules_python")
load("@//build/deps:gen/dep_rules_rust.bzl", "dep_rules_rust")

def deps_gen():
    dep_bazel_skylib()
    dep_rules_python()
    dep_build_bazel_apple_support()
    dep_rules_rust()
    dep_cargo_bazel_linux_x64()
    dep_cargo_bazel_linux_arm64()
    dep_cargo_bazel_macos_x64()
    dep_cargo_bazel_macos_arm64()
    dep_cargo_bazel_win_x64()
    dep_aspect_rules_esbuild()
    dep_rules_pkg()
    dep_aspect_bazel_lib()
    dep_aspect_rules_js()
    dep_aspect_rules_ts()
