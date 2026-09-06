"""Producer-side file policy; installed ownership is tested separately."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('alpha_package', ROOT / 'scripts/alpha/package.py')
assert spec is not None and spec.loader is not None
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class BuildInputs(unittest.TestCase):
    def test_cargo_style_hardlinks_are_regular_build_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'binary'
            binary.write_bytes(b'build output')
            alias = Path(temp) / 'deps-output'
            os.link(binary, alias)
            self.assertEqual(binary.stat().st_nlink, 2)
            package.regular(binary)
            self.assertEqual(binary.stat().st_nlink, 2)
            self.assertEqual(alias.read_bytes(), b'build output')

    @unittest.skipIf(os.name == 'nt', 'native junction acceptance in lifecycle suite')
    def test_symlink_build_input_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'binary'
            binary.write_bytes(b'build output')
            alias = Path(temp) / 'alias'
            alias.symlink_to(binary)
            with self.assertRaises(ValueError):
                package.regular(alias)


if __name__ == '__main__':
    unittest.main(verbosity=2)
