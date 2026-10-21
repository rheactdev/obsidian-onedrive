import org.cryptomator.cryptofs.CryptoFileSystemProvider;
import org.cryptomator.cryptofs.CryptoFileSystemProperties;
import org.cryptomator.cryptolib.common.MasterkeyFileAccess;
import org.junit.jupiter.api.Test;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Set;
import java.util.stream.Collectors;
import static org.junit.jupiter.api.Assertions.*;

public class CompatibilityTest {
    @Test
    public void opensDownloadedVaultWithoutPluginState() throws Exception {
        var export = Path.of(System.getenv("CRYPTOMATOR_EXPORT_PATH"));
        var raw = export.resolve("raw/vault");
        var expected = export.resolve("expected");
        var keyFileAccess = new MasterkeyFileAccess(new byte[0], new SecureRandom());
        var properties = CryptoFileSystemProperties.cryptoFileSystemProperties()
            .withKeyLoader(id -> keyFileAccess.load(raw.resolve(id.getSchemeSpecificPart()), "interoperability café 密码"))
            .withFlags(CryptoFileSystemProperties.FileSystemFlags.READONLY).build();
        try (var fs = CryptoFileSystemProvider.newFileSystem(raw, properties)) {
            var root = fs.getPath("/");
            Set<String> expectedPaths;
            try (var walk = Files.walk(expected)) { expectedPaths = walk.map(expected::relativize).map(Path::toString).collect(Collectors.toSet()); }
            Set<String> actualPaths;
            try (var walk = Files.walk(root)) { actualPaths = walk.map(root::relativize).map(Path::toString).collect(Collectors.toSet()); }
            assertEquals(expectedPaths, actualPaths, "Cryptomator must recover every file and empty directory");
            for (var name : expectedPaths) {
                var original = expected.resolve(name);
                if (Files.isRegularFile(original)) assertArrayEquals(Files.readAllBytes(original), Files.readAllBytes(root.resolve(name)), name);
            }
        }
    }
}
