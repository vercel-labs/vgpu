import ExternalGeneratedFixture
import VGPUABI

func acceptStorageType(_ type: Values.Storage.Type) {}
func acceptBindingType(_ type: Values.Binding.Type) {}

@main
enum CrossPackageConsumer {
  static func main() throws {
    acceptStorageType(Values.Storage.self)
    acceptBindingType(Values.Binding.self)
    _ = Values._vgpuRuntimeArrayLayout
    print("cross-package/storage/binding")
  }
}
